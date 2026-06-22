# revAgent Know-How Boundary Review

This document records the Phase 4 source-protection decision boundary for
revAgent product know-how. It does not change runtime behavior. Its purpose is
to keep later implementation phases from moving local workstation context,
Revit model data, or user Codex memory while still identifying reusable product
logic that may be worth protecting behind a controlled service boundary.

The primary goal is product IP protection, not user-data centralization.
User project data, model state, workstation Codex sessions, memory, and
operator context must stay out of service-backed product-logic flows unless a
later, separately approved design explicitly changes that rule.

## Decision Classes

| Class | Meaning | Default handling |
| --- | --- | --- |
| `local-only` | Behavior depends on live Revit state, operator context, model geometry, workbook contents, Codex session history, or low-latency UI state. | Keep on workstation. Harden package only. |
| `safe-to-ship` | Generic runtime contract, guard, packaging, or installer behavior that must execute offline and does not expose high-value domain heuristics by itself. | Ship in user pack after source-free and hardened bundle gates. |
| `service-backed-candidate` | Reusable scoring, inference, ranking, or promotion logic that can work from minimal structured summaries and has product value beyond one workstation. | Consider service boundary only after latency, offline fallback, versioning, and data-minimization design. |
| `hybrid-cache-candidate` | Static or slowly changing rule/index content that can be signed, versioned, cached locally, and updated separately from the runtime. | Keep a local cache; consider signed remote rule-pack distribution later. |
| `defer` | Not worth service complexity yet or blocked by operational risk. | Revisit only after usage evidence shows repeated value. |

## Boundary Principles

- Codex orchestration remains per workstation and per user. Codex session,
  memory, project history, and context are not service-backed in this phase.
- Live Revit operations remain local. Runtime tools may query or write the
  active model only through the installed Revit bridge and the current safety
  contract.
- User artifacts remain workstation inputs. Excel rows, schedules, sheet text,
  element samples, images, and model identifiers are not sent to a central
  product-logic service by default.
- Service candidates must consume minimized, non-reversible summaries, not raw
  models, raw workbooks, source documents, images, full telemetry streams, or
  token profiles that still reveal source text.
- No private signing keys, license secrets, service credentials, or policy
  authority may live in the client payload.
- Every service-backed candidate needs an offline fallback that is explicit in
  behavior, versioned, and testable.
- Packaging hardening and source-free release gates continue to protect the
  local payload even when logic remains local.

## Current Inventory

| Surface | Current location | Know-how type | Classification | Reason | Next gate |
| --- | --- | --- | --- | --- | --- |
| Codex `SKILL.md` and `AGENTS.md` user orchestration | user-pack Codex integration | Runtime instructions, tool routing, user workflow guardrails | `local-only` with minimal user surface | It depends on each user's Codex session, memory, Revit role, and live workstation context. It should be minimized and separated from developer docs, not centralized. | Keep user pack minimal; continue reviewing user vs developer instruction split. |
| Revit MCP status, UI state, active view, selection, and live activity | runtime MCP server and Revit add-in | Low-latency workstation coordination | `local-only` | These signals are only meaningful for the active machine and must guard command ordering. A service round trip would add risk without protecting reusable IP. | Keep local; harden bundle and result contracts. |
| Dynamic execution safety guards | `send_code_to_revit_safe_guards.ts`, native dynamic execution guard | Write detection, transaction discipline, safety classification | `safe-to-ship` | Guards must execute before unsafe local code reaches Revit. They are safety-critical and need offline behavior. | Keep local; protect through minified/source-free packaging and tests. |
| Shared result and broad-scan contracts | `broadScanResult.ts`, bridge result contract, command wrappers | Stable product API shape and partial-result vocabulary | `safe-to-ship` | The contract is necessary for local reliability and reviewability. Exposing the contract does not expose the highest-value domain scoring. | Keep local; continue compatibility tests. |
| Element search policy | `searchPolicy.ts`, `find_elements.ts`, native `ElementDiscoveryHelpers.cs` | MEP concept/category inference, scope risk policy, plan candidate ranking | `service-backed-candidate` for reusable inference tables; `local-only` for live Revit search | Concept aliases and ranking heuristics are reusable product know-how. The actual search, visibility checks, element scoring, and plan candidates require local Revit data. | Split future rule table from local executor; design signed rule-pack or service summary call before implementation. |
| Schedule-to-Excel normalization | `reconcile_normalization.ts`, Excel/schedule adapters | Header aliases, Turkish/Unicode normalization, unit/dimension tokenization | `hybrid-cache-candidate` | Static aliases and unit rules are reusable and can be versioned. Local file/schedule ingestion must stay local. | Consider signed rule-pack updates; keep local parser fallback. |
| Schedule-to-Excel matching/scoring | `reconcile_matching.ts`, `reconcile_schedule_excel.ts` | Candidate generation, score weights, thresholds, hard-conflict policy, review buckets | `service-backed-candidate` | Deterministic scoring is high-value product know-how, but the current token profiles and mapped values still derive from user workbook/schedule text. A future service must use redacted or hashed feature vectors, or keep scoring local. | Define a non-reversible feature-vector contract, latency budget, and offline fallback before moving. |
| Schedule, sheet text, annotation, and tag inspection | native inspect/count handlers, `AnnotationEvidenceHelpers.cs` | Revit API traversal, evidence shaping, scan budgets, continuation metadata | `local-only` plus `safe-to-ship` contract | Raw evidence depends on model/sheet contents and Revit API limitations. Budget and continuation contracts are safe to ship. | Keep traversal local; only aggregate lessons into rule candidates. |
| Controlled schedule and parameter writes | `set_schedule_cells*.ts`, `set_element_parameter.ts`, native write handlers | Write preflight, dry-run defaults, exact identity guards, verification | `safe-to-ship` | Writes must be guarded locally against the actual active model. Centralizing would increase failure modes and would not materially protect product heuristics. | Keep local; harden package and keep tests. |
| Image export and visual QA | export tools and native view/export handlers | View framing, crop, QA style, file output evidence | `local-only` | It depends on active model/view state and produces local files. Service movement would be operationally expensive and data-heavy. | Keep local; consider only signed style/rule presets later. |
| Usage telemetry raw events and live dashboard feed | `telemetry.ts`, dashboard, NAS report tree | Operation timeline, machine/session activity, result summaries | `local-only` for raw events; `service-backed-candidate` for aggregated product analytics | Raw events can include project/view/location hints and must not become a product-logic service input by default. Aggregated, minimized summaries can guide roadmap and promotion logic. | Define anonymized aggregation contract before any service use. |
| Usage-intelligence promotion rules | `config/dynamic-tool-promotion-*.json`, usage summary scripts | Tool promotion criteria, repeated-friction detection, product roadmap signals | `service-backed-candidate` | Promotion heuristics are reusable product know-how and can run on aggregated counters rather than raw project data. | Separate human-review evidence from automatic promotion authority. |
| Revit API docs MCP index | `installer/revit-api-docs-mcp` | Local API lookup/index and build-time docs ingestion | `hybrid-cache-candidate` | The index is static enough to sign and cache. Workstation lookup should remain local for speed and offline use. | Consider signed index/rule-pack distribution after integrity phase. |
| Installer, updater, no-source gates, no-map/no-PDB gates | installer scripts, release scripts, CI smoke gates | Distribution hygiene and artifact integrity | `safe-to-ship` | These are required locally to keep the release pack source-free and resilient. They do not contain domain scoring that merits service latency. | Keep local and extend in Phase 5 for signing/integrity. |

## Service Boundary Candidates

The following candidates have enough reusable product value to justify a later
design spike. They are not approved for implementation by this review alone.

1. MEP taxonomy and search-scope rules

   Move only generic concept aliases, category mappings, budget presets, and
   ranking weights. Keep model search, linked-model traversal, visibility
   verification, and result compaction local.

2. Reconciliation scoring profiles

   Move scoring weights, token role aliases, hard-conflict policy, bucket
   thresholds, and profile versioning. Keep Excel parsing, schedule reading,
   row text, source files, current token profiles, and mapped context values
   local unless a later design proves a non-reversible feature-vector contract
   that preserves unit conflict and context scoring without exposing user text.
   If that contract is not possible, keep reconciliation scoring local.

3. Usage-intelligence aggregation and promotion policy

   Move only aggregate counters, promotion thresholds, and product-level
   recommendations. Keep raw telemetry, project/view names, element ids,
   workbook paths, and Codex session context out of product-logic services
   unless separately approved.

4. Signed rule packs

   For static MEP dictionaries, Revit API indexes, style presets, and
   parameter aliases, prefer signed cached rule packs before a live service.
   This improves IP control and update cadence without making revAgent depend
   on network availability for ordinary model work.

## Explicit Non-Goals

- Do not move Codex session state, memory, or user project context into a
  revAgent service.
- Do not introduce runtime service calls into Revit write paths in this phase.
- Do not send raw Revit model data, raw schedules, raw Excel rows, screenshots,
  image exports, or raw telemetry to a product-logic service by default.
- Do not add licensing, signing, or remote entitlement secrets to the client.
- Do not remove local fallbacks for production workflows that must work during
  network, NAS, or service outages.

## Future Gate Checklist

Before any `service-backed-candidate` can move behind a service boundary, the
workstream must document and test:

- Minimal input and output schemas with raw user/model data, reversible source
  text, and current token profiles excluded by default.
- Redaction, hashing, or feature-vector rules for every field allowed to cross
  the boundary.
- Offline fallback behavior and how the UI/result contract reports fallback.
- Latency budget for interactive Revit use.
- Version compatibility between client bundle, rule profile, and service.
- Cache invalidation and signed rule-pack strategy where applicable.
- Failure behavior for service outage, authentication failure, and stale policy.
- Review of whether the change belongs in a separate PR from packaging gates,
  runtime behavior, telemetry policy, and deployment integrity.

## Phase 4 Outcome

Phase 4 classifies the know-how boundary and records future gates. It does not
move logic to a service, add a new service dependency, change runtime behavior,
or publish a release. The next implementation phases should use this document
to select narrowly scoped, separate PRs instead of revisiting the full boundary
from scratch.
