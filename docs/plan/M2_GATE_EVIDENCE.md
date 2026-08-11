# M2 Gateway Gate Evidence

**Evidence state:** `passed`

**Acceptance state:** `accepted` (milestone owner, 2026-08-11)

**Exact main anchor:**
[`011b17b0095e5190a4347fca81160cbb9138eae0`](https://github.com/BTankut/revAgent/commit/011b17b0095e5190a4347fca81160cbb9138eae0)

This document maps the M2 acceptance criteria to retained GitHub evidence. The
milestone owner recorded `M2 accepted` on 2026-08-11; that decision does not
enlarge the evidence below or erase its stated ceilings.

## Final exact-main evidence

- [Main CI run 31419029437](https://github.com/BTankut/revAgent/actions/runs/31419029437), attempt 1: Engineering gates and Gateway gates passed.
- [Gateway CI run 31419029495](https://github.com/BTankut/revAgent/actions/runs/31419029495), attempt 1: exact-head Gateway lint, typecheck, tests, secret scan, image build, and readiness artifact passed.
- [GW-13 readiness artifact 9074629966](https://github.com/BTankut/revAgent/actions/runs/31419029495/artifacts/9074629966): `revagent.gw13-readiness/v1`, source revision `011b17b...`, C01–C14 14/14, RES-14 seams 5/5, 151 assertions, and live-smoke dry-run ready.

The artifact is intentionally `authoritative:false`. As an immutable snapshot
generated before the owner decision, it historically records
`evidenceState:passed` and `acceptanceState:awaiting_milestone_owner`; the later
acceptance does not make it authoritative or add proof of real OAuth,
external-client hands-on, live Revit, APS runtime, or Mode-B activation.

## M2 acceptance map

| Acceptance criterion | Plan row(s) | Evidence | Result and ceiling |
|---|---|---|---|
| Collect the production tool registry and package immutable hash-bound legacy handlers behind `ExecutorPort`. | GW-1 | [PR #342](https://github.com/BTankut/revAgent/pull/342), [CI 30765806234](https://github.com/BTankut/revAgent/actions/runs/30765806234), [Gateway CI 30765806231](https://github.com/BTankut/revAgent/actions/runs/30765806231), [Claude 30770630912](https://github.com/BTankut/revAgent/actions/runs/30770630912) | Passed. Frozen-source relocation was not introduced. |
| Provide the production Gateway shell, frozen ports, deterministic auth seam, and non-executable Mode-B interfaces. | GW-2 | [PR #344](https://github.com/BTankut/revAgent/pull/344), [CI 30770916679](https://github.com/BTankut/revAgent/actions/runs/30770916679), [Gateway CI 30770916670](https://github.com/BTankut/revAgent/actions/runs/30770916670), [Claude 30770916677](https://github.com/BTankut/revAgent/actions/runs/30770916677) | Passed. Mode B remains typed fail-closed stubs only. |
| Materialize the E5 registry, entitlement/policy/executor map, and byte-stable capability index. | GW-3 | [PR #345](https://github.com/BTankut/revAgent/pull/345), [CI 31302722950](https://github.com/BTankut/revAgent/actions/runs/31302722950), [Gateway CI 31302722965](https://github.com/BTankut/revAgent/actions/runs/31302722965), [Claude 31302752081](https://github.com/BTankut/revAgent/actions/runs/31302752081) | Passed. Catalog contains the verified 40-tool surface. |
| Bind the entitled index to a north MCP slice and prove one executor-dispatched tool. | GW-3 integration | [PR #355](https://github.com/BTankut/revAgent/pull/355), [CI 31306913068](https://github.com/BTankut/revAgent/actions/runs/31306913068), [Gateway CI 31306913067](https://github.com/BTankut/revAgent/actions/runs/31306913067), [Claude 31308242082](https://github.com/BTankut/revAgent/actions/runs/31308242082) | Passed. This bounded proof was later completed as the full GW-10 production mount. |
| Enforce invocation context, registry/policy/scope authority, immutable audit correlation, durable mutation holds, exact-origin recovery, and restart-safe clearance. | GW-4 | [PR #356](https://github.com/BTankut/revAgent/pull/356), [CI 31319279712](https://github.com/BTankut/revAgent/actions/runs/31319279712), [PR #357](https://github.com/BTankut/revAgent/pull/357), [CI 31329120164](https://github.com/BTankut/revAgent/actions/runs/31329120164), [Gateway CI 31329120157](https://github.com/BTankut/revAgent/actions/runs/31329120157), [Claude 31329203271](https://github.com/BTankut/revAgent/actions/runs/31329203271) | Passed. Inconclusive or malformed evidence remains fail-closed. |
| Complete preview → pending action → single-use confirmation token → new commit invocation, with linked approval/commit audit. | GW-8 | [PR #358](https://github.com/BTankut/revAgent/pull/358), [CI 31335946436](https://github.com/BTankut/revAgent/actions/runs/31335946436), [Gateway CI 31335946453](https://github.com/BTankut/revAgent/actions/runs/31335946453), [Claude 31335955064](https://github.com/BTankut/revAgent/actions/runs/31335955064) | Passed under deterministic auth/session fixtures. Direct commit, replay, expiry, identity/session/scope drift, and client bypass fail closed. |
| Serve production Fastify `/mcp`, entitled capability-index instructions/resource, `tool_search`, `tool_schema`, pinned/session-sticky callable views, bounded schema activation, and bridge/internal executor dispatch. | GW-10 | [PR #359](https://github.com/BTankut/revAgent/pull/359), [CI 31361030670](https://github.com/BTankut/revAgent/actions/runs/31361030670), [Gateway CI 31361030702](https://github.com/BTankut/revAgent/actions/runs/31361030702), [Claude 31361043366](https://github.com/BTankut/revAgent/actions/runs/31361043366) | Passed. The coordinator's north endpoint + capability index + executor-dispatch gap is closed. Real OAuth remains M5. |
| Accept scoped client uploads/result pages and publish validated multi-file RBP artifacts without exposing workstation paths. | GW-9 | [PR #360](https://github.com/BTankut/revAgent/pull/360), [CI 31368314167](https://github.com/BTankut/revAgent/actions/runs/31368314167), [Gateway CI 31368314166](https://github.com/BTankut/revAgent/actions/runs/31368314166), [Claude 31369552925](https://github.com/BTankut/revAgent/actions/runs/31369552925) | Passed. Cross-scope, expiry, size, path, sibling, stream, and digest negatives fail closed. |
| Terminate WSS and exact HTTP/SSE fallback through one durable Bridge-session authority and dispatch the runtime catalog under journal/recovery semantics. | GW-12 | [PR #361](https://github.com/BTankut/revAgent/pull/361), [CI 31381467618](https://github.com/BTankut/revAgent/actions/runs/31381467618), [Gateway CI 31381467599](https://github.com/BTankut/revAgent/actions/runs/31381467599), [bridge simulator 31381467637](https://github.com/BTankut/revAgent/actions/runs/31381467637), [Claude 31381473900](https://github.com/BTankut/revAgent/actions/runs/31381473900) | Passed against frozen O1 and restartable fixtures. Real host, credentials, drivers, and deployment remain M6/M7. |
| Produce a machine-readable M2 readiness report covering the server-observable halves of WP9 C01–C14 and the five RES-14/P6-T1 seams. | GW-13 | [PR #362](https://github.com/BTankut/revAgent/pull/362), [CI 31389075589](https://github.com/BTankut/revAgent/actions/runs/31389075589), [Gateway CI 31389075922](https://github.com/BTankut/revAgent/actions/runs/31389075922), [Claude 31389089079](https://github.com/BTankut/revAgent/actions/runs/31389089079), [latest exact-main artifact](https://github.com/BTankut/revAgent/actions/runs/31419029495/artifacts/9074629966) | Passed as `authoritative:false`; the later owner acceptance does not satisfy the hands-on obligations. |
| Send registry-authorized atomic batches as one RBP batch/transaction group and replay durable terminal results without duplicate write execution. | GW-16 | [PR #363](https://github.com/BTankut/revAgent/pull/363), [CI 31398250044](https://github.com/BTankut/revAgent/actions/runs/31398250044), [Gateway CI 31398250470](https://github.com/BTankut/revAgent/actions/runs/31398250470), [Claude 31399962733](https://github.com/BTankut/revAgent/actions/runs/31399962733) | Passed. Write retry remains journal-governed. |
| Package version-pinned, module-scoped Phase-1 instructions/manifests and expose only entitled MCP resources. | GW-19 | [PR #364](https://github.com/BTankut/revAgent/pull/364), [CI 31407423144](https://github.com/BTankut/revAgent/actions/runs/31407423144), [Gateway CI 31407427358](https://github.com/BTankut/revAgent/actions/runs/31407427358), [Claude 31407658879](https://github.com/BTankut/revAgent/actions/runs/31407658879) | Passed. Gateway does not own the agentic loop. |
| Ingest promotion candidate/rule metadata into an admin-readable human-review feed without changing the entitled catalog or authorizing automatic promotion/priority. | GW-20 / RES-19 | [PR #365](https://github.com/BTankut/revAgent/pull/365), [CI 31414467959](https://github.com/BTankut/revAgent/actions/runs/31414467959), [Gateway CI 31414468979](https://github.com/BTankut/revAgent/actions/runs/31414468979), [Claude 31417424696](https://github.com/BTankut/revAgent/actions/runs/31417424696) | Passed. Review evidence remains human-only and catalog bytes/digest stay unchanged. |

## C01–C14 result map

All rows below are sourced from the exact-main GW-13 artifact linked above.

| Case | Server-observable evidence | Result |
|---|---|---|
| C01 | Deterministic fake client opens a north session. | `passed` |
| C02 | Authenticated principal, OAuth-client seam, and MCP session are bound without claiming OAuth proof. | `passed` |
| C03 | Durable RBP state resumes after reconnect/restart. | `passed` |
| C04 | Entitled capability index, search, schema activation, and forged-policy denial are coherent. | `passed` |
| C05 | A pinned read tool dispatches through the selected executor. | `passed` |
| C06 | Confirmation preview performs no write and retains the originating invocation. | `passed` |
| C07 | Token consumption is single-use; expiry and unrelated-preview negatives are durable. | `passed` |
| C08 | Dispatch, terminal journal evidence, and audit correlation retain the exact invocation. | `passed` |
| C09 | Progress is non-terminal; cancellation/reconnect/restart do not duplicate dispatch. | `passed` |
| C10 | Resource bytes are actor/session scoped and denied after expiry or integrity mismatch. | `passed` |
| C11 | Allowlisted upload bytes reach the executor without a client path. | `passed` |
| C12 | Multi-file output publishes only after every sibling validates. | `passed` |
| C13 | Outage/restart/hold evidence is durable and unavailable executors fail closed. | `passed` |
| C14 | WSS and HTTP/SSE share one authority; Mode B stays typed and non-executable. | `passed` |

## Known open boundaries

- WP9 C01–C14 must still run hands-on against the selected Codex Desktop build; visible Turkish UX, progress/cancel, downloaded-file opening, and Revit-visible results are not proven here.
- Real OAuth/DCR, token refresh/revoke, device enrollment, seats, and two-tenant negatives remain M5.
- Real host/credential/driver deployment and signed distribution remain later milestone work.
- APS runtime and Mode-B engines are not activated.
- RFC 8785 digest ownership transfer to `protocol.makeParamsDigest` remains a separate, index-ordered task.
