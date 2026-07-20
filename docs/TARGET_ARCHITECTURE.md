# RevAgent — Target Architecture & Migration Plan

**Document status:** Compiled architecture baseline, approved for detailed implementation planning.
**Date:** 2026-07-20
**Audience:** Master-planner coding assistant. This document defines *what* to build and *why*; the reader's job is to produce the detailed implementation/coding plan (*how*). Alternatives were evaluated and closed during architecture review; do not re-open decisions marked D1–D12 unless a listed constraint is found to be false.
**Product:** RevAgent — an MCP-based technical assistant for Revit. An LLM resolves natural-language instructions from engineers/draftsmen by invoking a tool set exposed over MCP, guided by AGENTS.md / SKILL.md instruction files.

---

## 1. Current State (As-Is)

- Every user workstation runs the **full stack**: C# Revit add-in + Node/TypeScript MCP runtime (tool registry, orchestration glue), connected to a cloud LLM with per-machine API access.
- Add-in ↔ runtime communicate over a local **TCP socket with length-prefixed framing** (a resolved 8192-byte limit bug; the framing layer is stable and proven).
- MCP transport is **stdio**, consumed by local MCP clients.
- Fleet deployment is a **NAS-hosted PowerShell script** pushed to each workstation.
- Existing subsystems that must survive unchanged in function:
  - Deterministic **duct auto-routing engine** (C#, V2: operator algebra, immutable DesignState, constraint propagation, deterministic beam search; 113 passing tests).
  - **CSI structural module** (in development): dedicated C#/.NET MCP server for ETABS/SAP2000 via OAPI (COM), three-tier LLM control, strict human gates for life-safety decisions.
  - **VLM visual-perception layer** (in development): closed-loop validation with stateless sub-agent design for context isolation.
- CI/CD: GitHub Actions with a self-hosted runner labeled `revagent-cd`; SemVer; lightweight main-branch flow; automated AI PR review.
- Two **admin-only layers** operate alongside RevAgent today and must be carried into the target architecture: (a) an **admin dashboard**, (b) a **usage intelligence** system. Current implementations and data sources are to be inventoried — see O11.

## 2. Drivers and Constraints

**Drivers**
1. **Context growth:** tool count is increasing; architectural (arch), structural (struct), and electrical (elec) modules with new tools land within months. Preloading all tool schemas degrades LLM selection accuracy at scale, inflates cost/latency, and breaks prompt-caching economics.
2. **Fleet burden:** N workstations × full stack = N update targets, N API keys, no central licensing/telemetry/audit. Untenable for a commercial product.
3. **Personas:** (a) *Designers* — high-end desktops, full Revit, ACC cloud worksharing with locally synced live models. (b) *Reviewers* (consultants/QC, procurement, fabrication/field) — Revit on the web, basic machines, review + schedule/quantity extraction. Persona (b) cannot run any local component.
4. **Customer profile:** firms on Revit + ACC, own office LANs, 10–150 users, remote workers possible.
5. **Commercialization:** SaaS product; licensing/seats, SSO, tenant isolation, audit trail required.
6. **LLM strategy:** cloud LLM today; a **local-LLM path must remain first-class** (on-prem/air-gapped offering is a market differentiator).

**Hard constraints**
- Revit API is **in-process**: any code touching a live desktop Revit session must run inside that session (add-in). Execution against live models can never be centralized.
- Revit API calls are effectively **serial per session**.
- Corporate firewalls: assume no inbound ports on customer networks; remote workers must work without VPN in the SaaS variant.

## 3. Key Decisions (Closed)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Centralize the **control plane** (orchestration, registry, LLM access, auth/licensing/audit) into a Gateway; keep the **execution plane** distributed (add-in + bridge on workstations). | Revit API is in-process; coordination is the only movable load. |
| D2 | Gateway = the MCP backend. **One codebase, one container image**, three deployment variants: SaaS multi-tenant (primary), single-tenant VPC, on-prem container. | Deployment is a sales option, not an architecture fork. |
| D3 | Bridge connectivity is **outbound-only** over 443 (WSS / Streamable HTTP), dial-out and stay connected. | No inbound ports, no VPN, remote workers first-class; same pattern as self-hosted CI runners. |
| D4 | **MCP lives only at the north boundary** of the Gateway (remote MCP server: Streamable HTTP + OAuth). Gateway ↔ bridge is an internal RPC protocol (NOT MCP). Add-in ↔ bridge keeps the existing TCP length-prefixed framing. | MCP is the industry-standard plug for external agent clients; internal hops need session routing, idempotency, and batching that MCP does not provide. |
| D5 | Context strategy: a **capability index** (one line per tool) always in context; full schemas **deferred** (tool-search pattern); a **code-execution mode** as the second engine mode. | Preserves capability awareness while cutting schema tokens; measured accuracy improves with deferred loading at large catalog sizes; code-exec mode is model-agnostic and carries the local-LLM path. |
| D6 | **Discipline namespaces** (mech / arch / struct / elec) are isolated; per-discipline stateless sub-agents; the four disciplines' tools are never co-resident in one context. | Context isolation scales module growth. |
| D7 | **Two data planes** mapped to personas: *live model* via bridge (designers) and *published model* via Autodesk Platform Services (reviewers). | Reviewers have no Revit process; published-model semantics match how ACC firms already work. |
| D8 | LLM access through a **provider abstraction** (OpenAI-compatible endpoint contract); cloud vs local model is a configuration switch. The combination "vendor-cloud gateway + customer-local LLM" is **rejected** (requires inbound access into the customer network and defeats the purpose of a local LLM). | Local-LLM path stays alive; invalid topology excluded by design. |
| D9 | The agentic loop is **owned in-house** (portable across providers and local models). The north MCP surface additionally allows provider-hosted loops (e.g., an LLM provider's MCP connector) or third-party MCP clients to consume the Gateway directly. | Avoids provider lock-in of the loop without closing that door for customers. |
| D10 | Phase 1 runs the Gateway **on-prem on a dedicated spare office PC** as *tenant #1* (dogfooding), built 12-factor from day one so migration to cloud is a redeploy, not a rewrite. | Own office becomes the staging environment for the SaaS product and the on-prem edition simultaneously. |
| D11 | Migration sequence: **build → single-workstation pilot → hard fleet cutover → NAS frozen 2 weeks as rollback insurance → retire NAS**. The old path is never removed before the new path has carried real traffic. | Converts open-ended office downtime into one planned cutover window; preserves rollback. |
| D12 | Guardrails: every tool carries a **policy class** — `auto` (read/query), `confirm` (destructive; preview → user approval → execute), `gated` (life-safety, mandatory human gate, non-bypassable — CSI module). Deterministic engines validate all inputs: **LLM proposes, engine verifies.** | Safety and liability chain for a BIM product. |

## 4. Target Topology

```
                 ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐
                 │ Cloud LLM API │   │  Local LLM   │   │ Autodesk APS / ACC   │
                 │ (Anthropic /  │   │ (on-prem GPU │   │ AEC Data Model API,  │
                 │  OpenAI)      │   │  cluster)    │   │ Design Automation    │
                 └──────▲───────┘   └──────▲───────┘   └──────────▲───────────┘
                        │                  │                      │
┌───────────────────────┴──────────────────┴──────────────────────┴───────────┐
│                        REVAGENT GATEWAY  (container)                        │
│  north boundary: remote MCP server (Streamable HTTP + OAuth)                │
│                                                                             │
│  1 Orchestration Engine   2 LLM Provider Layer   3 Tool Registry            │
│  4 Auth · Licensing · Audit                      5 APS Integration          │
│                                                                             │
│  deploy variants: SaaS multi-tenant │ single-tenant VPC │ on-prem container │
└──────────▲──────────────────────────▲──────────────────────────▲────────────┘
           │ outbound WSS/HTTP        │ outbound WSS/HTTP        │ HTTPS
 ┌─────────┴──────────┐    ┌──────────┴─────────┐     ┌──────────┴──────────┐
 │ Designer workstation│    │ Remote designer    │     │ Reviewer / field    │
 │ Revit + C# add-in   │    │ identical bridge,  │     │ browser only,       │
 │ + thin bridge       │    │ no VPN             │     │ web chat client     │
 └─────────────────────┘    └────────────────────┘     └─────────────────────┘
```

All client links dial out. Model files never traverse RevAgent channels (Revit ↔ ACC sync remains Autodesk's own channel).

## 5. Component Specifications

### 5.1 Gateway (the MCP backend)

Stateless service processes behind a reverse proxy; all state in the data layer (Section 5.9). Five subsystems:

1. **Orchestration Engine** — owns the agentic loop (Section 5.2).
2. **LLM Provider Layer** — single adapter contract (OpenAI-compatible); per-model capability flags (supports tool-search? supports code-exec? context size; cost class). Model routing config (Section 5.2, stage 2).
3. **Tool Registry** — source of truth for: tool schemas, discipline namespace membership, policy class (`auto`/`confirm`/`gated`), executor binding (bridge / APS / internal), per-tenant module licensing, tool + SKILL/AGENTS content versioning. Generates the **capability index** (one line per tool) per tenant/module entitlement. Future discipline modules (including the CSI/ETABS server) attach behind the Gateway as internal MCP servers registered here.
4. **Auth · Licensing · Audit** — OIDC/SSO for users; device-token enrollment for bridges; seat check at connection time; tenant isolation; audit event per tool invocation: `(actor, tenant, session, document/model id, tool, params digest, policy class, outcome, timestamps)`; token metering per tenant/model/tool.
5. **APS Integration** — the reviewer data plane (Section 5.6).

### 5.2 Orchestration Engine — request lifecycle

Five stages per turn, looping until the plan completes; then the answer streams to the user.

1. **Context assembly.** Context is a **projection rebuilt from server-side session state each turn**, never an append-only log. Projection contents: static prefix (system instructions + capability index — this prefix is the prompt-caching boundary), bridge-supplied document context (open document, active discipline hint), recent messages, summarized older tool results. Old tool results are evicted/edited out. Target invariant: turn-30 context is not materially larger than turn-3 context.
2. **Planner / router.** Lightweight classification (small/cheap model): discipline namespace → mech/arch/struct/elec; data plane → live (bridge) vs published (APS); complexity → simple query vs multi-step plan. The main planning turn goes to the large model. Rationale: at 100+ users, most queries are parameter-level lookups that do not merit the large model.
3. **LLM turn** via the provider layer, in one of two engine modes selected by model capability flags:
   - **Mode A — tool-calling:** capability index in context; full schemas deferred and retrieved on demand (tool-search pattern). Keep the 3–5 core tools (e.g., element query, document context) non-deferred.
   - **Mode B — code execution:** the model writes a script in a sandboxed runtime (network closed except tool RPC); tools appear as wrappers in a filesystem tree; intermediate data (large element lists) is processed inside the sandbox; only summaries re-enter model context. Mode B is model-agnostic and is the designated **local-LLM path**.
4. **Tool runtime + dispatch.** Routing table (from registry) maps each invocation to an executor: bridge session (live Revit), APS integration (published model), or gateway-internal (calculations, deterministic engines, docs). Rules:
   - Per-session **serial execution** for Revit-bound calls; parallelism only for APS/internal calls.
   - **Batch primitive:** consecutive Revit-bound operations are shipped as one message and executed by the add-in as **one transaction group** (N round-trips → 1).
   - **Idempotency key** on every invocation; bridge-side operation journal deduplicates redelivery after reconnects.
   - Retry policy per executor class: APS retryable; Revit writes never retried without consulting the journal.
5. **Result hygiene.** Size caps; server-side filtering already applied in the add-in; summarization; large payloads stored in the session store under a `result_ref` — the model receives "2,400 elements found, ref:R17, first 20 shown" and can page by reference. In Mode B most of this is free (raw data never enters context).

**Cross-cutting:**
- **Sub-agents:** orchestrator holds the master plan; per-discipline stateless sub-agents receive a narrow context slice + only their namespace tools; return summaries. Generalization of the existing VLM sub-agent pattern.
- **Guardrails:** enforce policy classes (D12). `confirm` = generate preview → explicit user approval → execute. `gated` = mandatory human gate (CSI life-safety), non-bypassable, tenant-tightenable.
- **Failure semantics:** tool errors return to the model as structured errors (retryable vs terminal, parameter fault vs environment fault); after 2–3 failed attempts the engine breaks the loop and emits a clean user-facing explanation. No unbounded tool-retry loops.
- **Statelessness:** engine instances hold no session state → horizontal scaling behind a load balancer; zero-downtime gateway upgrades (bridges reconnect, sessions resume from the store).

### 5.3 Context management strategy (summary of D5/D6)

- Capability index: one line per tool (name + one-line description), generated per tenant entitlement; always in context; part of the cached static prefix.
- Full schemas: deferred (Mode A) or represented as code wrappers on a filesystem (Mode B).
- Naming is API design: discipline-prefixed, keyword-rich tool names and descriptions (e.g., `mech.duct.route`, `elec.cable_tray.query`) because discovery/search matches on names, descriptions, and argument names/descriptions.
- Prefer few parameterized tools over many fine-grained ones; filtering happens in the C# add-in, not in the LLM (`query_elements(filter)` replaces N getters).
- The four discipline toolsets are never co-resident in one context (sub-agent isolation).

### 5.4 Thin Desktop Bridge

Minimal connector installed with the add-in on designer workstations. Responsibilities:
- Enrollment with a device token; session registration `(user identity, machine, open documents)`; heartbeat.
- Persistent **outbound** connection to the Gateway DNS name (never an IP); reconnect with exponential backoff; session resume after reconnect/wake.
- Execute received invocations against the live Revit session via the existing add-in TCP framing; stream results back.
- **Idempotency journal:** record `(invocation id → outcome)`; on redelivery, answer from the journal instead of re-executing. This is the primary defense against duplicate model mutations on flaky links (remote workers).
- Execute **batch messages** as a single Revit transaction group.
- **Self-update:** poll the Gateway version manifest; download and apply signed updates. (The bridge is the last component ever delivered by fleet push.)

### 5.5 Web Chat Client

One client for both personas (browser; no install for reviewers). Talks to the Gateway. Phase-1 scope may be minimal; note (Section 9, open item O8) that during Phase 1 the Gateway's north MCP surface also allows existing MCP clients (e.g., Claude Code) to consume it directly while the web client matures.

### 5.6 APS Integration (reviewer data plane)

- **Read/query/schedules:** AEC Data Model API (GraphQL) against published Revit (2024+) models in ACC — element/property queries without any Revit install; Extended Properties for API-side data writes (e.g., fabrication IDs) outside the model.
- **Model writes:** Design Automation for Revit — headless cloud Revit engine; opens cloud (incl. workshared) models directly for Revit 2022+ under a 3-legged OAuth user context; executed as batch jobs.
- **Product truth to preserve in UX:** designers operate on the *live* model, reviewers on the *published* version; surface this distinction, never blur it.

### 5.7 Protocol boundaries (D4)

| Hop | Protocol | Notes |
|---|---|---|
| External MCP clients → Gateway (north) | MCP over Streamable HTTP + OAuth | The productized "Revit MCP" plug; also consumable by provider-hosted loops. |
| Web client → Gateway | HTTPS (app API) | Chat/session API. |
| Gateway ↔ Bridge | Internal RPC over outbound WSS/Streamable HTTP | Handshake, session resume, invocation, batch, idempotency, streaming. **Not MCP.** Spec = open item O1. |
| Bridge ↔ C# add-in | Existing TCP length-prefixed framing | Proven; keep. |
| Gateway → LLM | Provider adapter (OpenAI-compatible contract) | Cloud or local endpoint by config. |
| Gateway → APS | HTTPS (GraphQL + REST) | AEC DM, Design Automation, token management. |

### 5.8 Deployment variants (D2)

| Variant | Where the Gateway runs | LLM | Notes |
|---|---|---|---|
| SaaS multi-tenant (primary) | Vendor cloud, placed **near the LLM region** (gateway↔LLM is the latency-sensitive leg) | Cloud API | Zero backend on customer LAN; remote + reviewers native. Data-residency options (KVKK/GDPR) later. |
| Single-tenant VPC | Customer's cloud tenant | Cloud API | Isolation for larger firms. |
| On-prem container | Customer office server | Cloud API **or** local LLM | With local LLM = fully on-prem AI; truly air-gapped only if the customer uses file-based worksharing instead of ACC. Remote access then requires VPN or customer-published reverse proxy — a deployment consequence, stated at sales time. |

Rejected: vendor-cloud Gateway + customer-local LLM (D8).

### 5.9 Data layer

- **Postgres:** session state, tool registry data, tenants/users/devices/seats, audit log. `tenant_id` on every table from day one (cheap now, painful retrofit).
- **Object storage:** large tool-result payloads (`result_ref`), update artifacts, backups.
- Gateway processes stateless; all durable state here.

### 5.10 Admin Plane — Dashboard & Usage Intelligence

Both existing admin-only layers migrate from workstation-era data collection to **consumers of the Gateway's event stream** — they read; they no longer collect:

- **Dashboard:** admin UI over the Gateway data layer — live sessions and connected bridges, bridge/fleet versions, tool-invocation feed (audit), failure rates, token spend, licensing/seat status.
- **Usage Intelligence:** analytics over the telemetry/metering events (Section 6, Observability) — usage per user/tool/discipline/model, latency distributions, cost attribution, adoption trends.
- **Access model — RBAC:** `admin` role distinct from `user`. In the multi-tenant future, two admin scopes: *vendor admin* (cross-tenant fleet view) and *tenant admin* (own firm only). Cross-tenant analytics only aggregated/anonymized (product decision, later).
- **Design rule:** no separate collection pipeline. If the dashboard or usage intelligence needs a metric, that metric becomes part of the O7 event schema.

## 6. Non-Functional Requirements

- **Security:** zero-trust, identity-based (no network-based trust; LAN and remote users traverse the identical path). TLS everywhere from day one. LLM API keys exist **only** at the Gateway. Outbound-only clients; no inbound ports on customer networks (SaaS/VPC variants). Role-based access control: `user` / `admin` from day one (later split into vendor-admin vs tenant-admin) gating the admin plane (Section 5.10).
- **Scalability:** Gateway is I/O-bound (waits on LLM seconds and bridge results); event-loop runtime; stateless horizontal scale. Real bottleneck candidates: LLM provider rate limits (per-tenant quota/queue management) and instance count (load balancer).
- **Availability:** assistant-down ≠ Revit-down (graceful degradation). Phase 1: warm standby (Section 7), RPO ≤ 5 min, RTO ≤ 30 min, manual/scripted DNS switch. No active-active in Phase 1 (split-brain risk outweighs minutes of downtime). SaaS phase: HA behind LB on managed infra.
- **Auditability:** every invocation produces an audit event (Section 5.1.4) — "who changed what, in which model" is a marketable feature (BIM liability chain).
- **Observability:** token metering per tenant/model/tool; tool latency and failure-rate telemetry to drive pruning and routing decisions.

## 7. Phase 1 — Office Deployment (Tenant #1)

Purpose: the own office becomes the SaaS staging environment and the on-prem edition simultaneously (dogfooding).

- **Host:** dedicated spare office PC (UPS + generator available). **Ubuntu Server**, not Windows (7×24 service; avoid update-reboot cycles). Dedicated — do not co-locate with the existing 24/7 dev machine; at minimum an isolated VM.
- **Stack:** Docker Compose: gateway service(s), Postgres, reverse proxy (Caddy or Traefik with automatic TLS), object-storage volume. All environment-specific values (LLM endpoint/keys, DB, domain) in environment/config — 12-factor; nothing environment-specific in code.
- **Addressing:** clients connect to a controlled DNS name (e.g., `gateway.<domain>`), never an IP/hostname. Public exposure via an outbound tunnel (Cloudflare-Tunnel-style): stable HTTPS endpoint, no router port-forwarding, works without a static IP.
- **Warm standby:** continuous Postgres backups (WAL archiving or frequent dumps) to cloud object storage; a cheap cloud VM holding the same Compose file; failover = restore latest backup + low-TTL DNS switch; bridges re-attach via their reconnect logic; sessions resume from the store. **A restore drill on a blank VM is mandatory before go-live** (an untested backup is not a backup).
- **Known residual risk:** single WAN line — power is covered, the internet line is not; add LTE failover if remote access matters in Phase 1.
- **Migration target:** moving to any future server/cloud = compose up + DB restore + DNS repoint.

## 8. Migration Plan (D11)

Freeze feature development for the duration.

1. **Build** — implement Gateway + Bridge; transport of the Node/TS runtime moves stdio → Streamable HTTP; runtime relocates from workstations to the Gateway. The office keeps working on the untouched old system (no downtime during build/debug).
2. **Pilot (one workstation, a few days of real work)** — validates the bridge, session routing, idempotency/reconnect behavior, the installer, and the self-update path. The other workstations stay on the old system.
3. **Hard cutover window (one evening/weekend, ~12 machines)** — wipe old stack, install self-updating bridge (this is the **final** fleet push ever), verify each machine connects and executes.
4. **Rollback insurance** — NAS scripts frozen-but-restorable for 2 weeks; pre-written rollback criterion (e.g., "if X is not functional by time Y, restore the old stack from NAS once"). 
5. **Retire** — archive NAS deployment permanently.

Iron rule: the old path is not removed before the new path has carried real traffic.

## 9. What Does NOT Change

- C# Revit add-in (adapted to the bridge, not rewritten); all tool implementations; the duct auto-routing engine; add-in↔runtime TCP framing (becomes the add-in↔bridge hop).
- CI/CD pattern: GitHub Actions + `revagent-cd` self-hosted runner, extended to Gateway CD (build → image → runner on the gateway host pulls & restarts).
- CSI module design (attaches behind the Gateway as an internal MCP server; its human-gate policy maps to policy class `gated`).
- VLM stateless sub-agent pattern (generalized to discipline sub-agents).
- AGENTS.md / SKILL.md as the instruction layer (served/versioned from the Tool Registry; the capability index is derived from it).

## 10. Open Items for the Detailed Implementation Plan

| # | Item | Notes |
|---|---|---|
| O1 | Bridge↔Gateway protocol spec | Handshake, auth, session registration/resume, invocation + batch message structure, idempotency journal semantics, streaming, heartbeat/timeouts. **First deliverable; precondition for the pilot.** |
| O2 | Code-execution sandbox design | Runtime choice, tool-wrapper generation from registry schemas, filesystem layout, egress policy, resource limits. |
| O3 | Tenant & data model schema | Tenants, users, devices, seats, sessions, audit, result_ref store. |
| O4 | APS integration details | OAuth apps and scopes, token lifecycle, AEC DM query mapping to existing schedule tools, Design Automation job templates. |
| O5 | Licensing/entitlement model | Module-level (mech/arch/struct/elec) entitlements; seat semantics; enforcement points. |
| O6 | Module packaging | How a discipline module (tools + SKILL/AGENTS + policies) is packaged, versioned, and registered. |
| O7 | Telemetry/event schema | Audit + metering + tool-latency events. |
| O8 | Phase-1 client scope | Minimal web chat client vs. interim use of existing MCP clients (e.g., Claude Code) against the north MCP surface. |
| O9 | Bridge self-update mechanism | Manifest format, signing, staged rollout. |
| O10 | Backup/restore runbook | Scripts + drill checklist for the warm-standby procedure. |
| O11 | Admin-plane migration | Inventory current dashboard + usage-intelligence features and data sources; verify **before cutover** that every currently tracked metric is derivable from the O7 event schema (metric-parity check). Historical usage data is **not** migrated (decision closed): the new store starts fresh; old data may remain as a read-only archive until NAS retirement. |

---

*End of document.*
