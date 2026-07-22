# M3 Bridge Start and RBP Alignment Evidence

| Field | Value |
|---|---|
| Work package | WP3 / M3 Bridge, add-in adaptation, installer |
| Review baseline | `origin/main` at `033af03` (`#278` merged; O1 `1.0-rc.1`, not frozen) |
| Required implementation baseline | Exact O1 v1.0 tag/commit plus merged `packages/protocol/schemas/rbp/v1/{common,payloads,envelope}.schema.json`; replace this pending reference with the frozen identities after M1, never implement from stale `ae94618` |
| Recorded | 2026-07-22 |
| Status | Start alignment only; M3 is not exited |

## Purpose

This record makes the first M3 slice reviewable before Bridge implementation begins. It aligns
`03-bridge-addin-installer.md` with the authoritative resolutions without claiming that the O1 v1.0,
transport, journal, add-in, installer, or pilot gates have passed.

## Resolution-to-plan evidence

| Authority | M3 plan consequence | Evidence in `03-bridge-addin-installer.md` |
|---|---|---|
| RES-3 / frozen O1 schemas | Cached `get_document_context` emits the exact schema-generated `doc_context_update`; RBP `display={task_name,logical_tool_name,parent_task_id}` remains distinct from the six add-in camelCase side-channel keys. | P-BRIDGE-5/P-BRIDGE-6, P3-T1/P3-T7, golden-vector strategy |
| RES-4 | The additive add-in command is `execute_batch`; `batch_execute` is invalid. | Scope item 2, P-ADDIN-3, P3-T5/T6, live test strategy |
| RES-10 | Ordinary invocation dispatch has no `mcp_status` busy preflight. | Non-goals, P-BRIDGE-4, P3-T3 and its acceptance test |
| RES-16 | Gateway window=1 is authoritative; Bridge queue is defense-in-depth. | P-BRIDGE-4 and P3-T3/T5 |
| RES-17 | No `%TMP%\revAgent-instances.json`; discovery is explicit loopback override or bounded scan plus shape probe. | Non-goals, P-ADDIN-5, P3-T3, risk R10 |
| RES-21 | Journal and audit use `rsid + "/" + invocation_id`, with indeterminate-write verification hold. | P-BRIDGE-3 and P3-T5 |
| RES-23 / DP-10 | ChatGPT/Codex Desktop remains the Phase-1 external-loop client; cutover removes only its exact two managed legacy local MCP sections, preserves all other user-owned Codex/AGENTS/skills/profile surfaces, then registers remote MCP. | Scope item 5, P-INST-3, P-CODEX-1, P3-T10/T14, pilot test |
| RES-25 / DP-2 | WSS primary and capability-gated Streamable HTTP/SSE fallback share RBP state and conformance. | Scope item 1, P-BRIDGE-7, P3-T4, transport-parity test, risk R5 |
| RES-6 / P-SEQ-2 | Cutover preserves the protected bootstrap/prestage/trusted-key rollback anchors byte-identically through Retire. | P-INST-3, P3-T10, installer/uninstaller matrix |
| RES-9 / P-CD-3 | Bridge CD uses a dedicated workflow and does not modify the frozen NAS signed-release workflow. | P3-T12 |
| R-B / M1 gate | Planning and local/draft preparation may proceed, but no M3 implementation PR merges before O1 v1.0/M1 freeze. | Work-breakdown preface, total/dependency note, risk R7 |
| R-D / P8-T8 freeze gate | Add-in adaptation is later, bounded, checkbox-attested, labeled, review-gated, and recorded before any frozen path changes. | Migration-freeze subsection and P3-T6 |

## Bounded M3 start sequence

1. Land this documentation alignment without changing runtime or frozen paths.
2. While M1 evidence is still open, keep any standalone shared-contracts project and byte-fixture work local
   or in draft; do not merge an M3 implementation PR.
3. Likewise keep any .NET 8 host/worker Bridge skeleton and console/doctor lifecycle work local or in draft.
4. Consume the O1-T3-owned exact add-in loopback fixture from the Bridge TCP client to prove bounded discovery,
   no temp registry, and zero ordinary-invocation `mcp_status` traffic; do not create a divergent M3 fixture.
5. Only after O1 v1.0/M1 freeze evidence is green may the new-path M3 implementation PRs merge, followed by
   the shared WSS/HTTP-SSE RBP connection state machine and journal in dependency order.
6. Only after the frozen contract and new-path fixture evidence are green, open the bounded add-in adaptation
   PR; check the P8-T8 PR-template freeze box, apply the exact `migration-freeze-exception` label, obtain a green
   Claude freeze review gate, and add the dated R-F record before readiness/merge.

The selected client's remote MCP registration and hands-on proof remain WP9-owned. WP3 consumes that
procedure in cutover; it does not replace the selected client or add an in-house Phase-1 agentic loop.

## Mechanical checks for this start slice

```powershell
git diff --check
git diff --name-only origin/main...HEAD
rg -n "batch_execute|mcp_status|revAgent-instances|Streamable HTTP|RES-23|migration-freeze-exception" `
  docs/implementation-plan/03-bridge-addin-installer.md
rg -n "task_name|logical_tool_name|parent_task_id|taskName|wrapperAction|doc_context_update|payloads.schema" `
  docs/implementation-plan/03-bridge-addin-installer.md
```

Pass conditions:

- changed paths are documentation only;
- neither `installer/runtime-mcp-server/src/tools/**` nor `src/revit-plugin/**` changes;
- every `batch_execute` match states that the name is invalid rather than prescribing it;
- every temp-registry and hot-path-preflight match states their removal/prohibition;
- RBP `display` has exactly three frozen snake_case fields, is explicitly distinct from the six recognized
  add-in camelCase side-channel fields, and golden vectors cover the allowlisted mapping;
- `doc_context_update` names its exact frozen payload and schema/golden-vector source;
- user-owned cleanup is limited to `[mcp_servers.revAgent]` and `[mcp_servers.revAgent-api-docs]`, with
  `AGENTS.md`, skills, PowerShell profiles, and every other Codex config entry retained;
- the plan does not claim M1 or M3 completion.

## Remaining entry gates

- O1 v1.0/M1 freeze and its executable conformance evidence must be green before any M3 implementation PR merges.
- Replace the pending implementation-baseline row with the exact frozen O1 tag/commit and merged schema identities;
  neither `ae94618` nor the current `1.0-rc.1` review baseline is an implementation contract.
- The add-in adaptation requires the checked P8-T8 freeze box, exact freeze-exception label, green Claude
  freeze review gate, and dated R-F record.
- WP9 hands-on ChatGPT/Codex Desktop conformance must be green before pilot/cutover.
- Live Revit, installer, self-update, WSS/fallback parity, soak, and rollback evidence remain open M3 work.
