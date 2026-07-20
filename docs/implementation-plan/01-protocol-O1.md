> Part of the RevAgent implementation plan (see `00-INDEX.md`).
> Normativity: `docs/TARGET_ARCHITECTURE.md` → `00-INDEX.md` resolutions (RES-*/GAP-*) → this section.
> Where this section conflicts with a resolution in `00-INDEX.md`, the index wins.

# Package P1 — O1: Bridge↔Gateway Internal RPC Protocol ("RBP/1") — Draft Spec, Work Breakdown, Conformance Plan

Protocol name used throughout: **RBP/1** (RevAgent Bridge Protocol, version 1). This is the D4 "internal RPC" hop (Gateway ↔ Bridge, NOT MCP). Per TARGET_ARCHITECTURE.md §10/O1 this is the **first deliverable and the precondition for the D11 pilot**.

---

## (a) Scope & Non-Goals

**In scope**
- The normative wire protocol between Gateway and thin desktop Bridge: transport, connection lifecycle (enroll/auth/register/heartbeat/reconnect/resume), message envelope, message types, error taxonomy, idempotency-journal semantics, flow control and size limits, version negotiation.
- The O9 *touchpoint only*: the version/manifest-check message shapes ride RBP/1; the update download/verify/apply mechanism itself is O9.
- An explicit pass-through mapping for all 21 existing add-in TCP commands + the `mcp_status` pseudo-method (src/revit-plugin/revAgentCommandSet/command.json:10-116; SocketService.cs:522-526), preserving the add-in hop byte-compatibly per §9 ("add-in↔runtime TCP framing … becomes the add-in↔bridge hop").
- A conformance harness (bridge simulator + gateway stub + add-in loopback fixture) runnable in Linux CI without Revit, plus one real-add-in interop smoke.

**Non-goals (owned elsewhere in the master plan)**
- Bridge product implementation (installer, service wrapper, tray UI) and self-update apply logic (O9 package).
- Enrollment/auth backend, tenant/user/device data model (O3/O5) — RBP/1 defines only the token presentation and claims consumed at handshake.
- Gateway orchestration engine, tool registry, MCP north surface, result-hygiene/`result_ref` store (§5.2/5.9 packages) — RBP/1 defines only how raw results arrive at the Gateway.
- Any change to the C# add-in or the RevitMCPSDK NuGet (revAgentPlugin.csproj:46). RBP/1 is designed so the pilot ships with the add-in **unchanged**; the one add-in follow-on it enables (`execute_batch`, atomic transaction group) is specified as a message shape here but implemented in the add-in adaptation package.
- Feature work of any kind (feature freeze per §8).

---

## (b) Plan-Level Design Decisions

| ID | Decision | Rationale (one line) |
|---|---|---|
| P-O1-1 | **WSS is the sole Phase-1 transport** (persistent outbound WebSocket over 443 to the Gateway DNS name). The envelope is transport-agnostic JSON; a Streamable-HTTP fallback is reserved behind a handshake capability flag (`transport_fallback`) and NOT built in Phase 1. | One transport = one connection state machine to conformance-test before the pilot; D3 requires only outbound-dial, which WSS satisfies. |
| P-O1-2 | One envelope per WebSocket **text frame**, JSON, no custom binary framing; large results are chunked via `partial` frames. | Mirrors the proven JSON hop (SocketService.cs framing already handles re-framing/oversize), keeps wire debugging trivial; permessage-deflate is a transport concern, not protocol. |
| P-O1-3 | **Single correlation chain:** the Gateway mints `invocation_id` (UUIDv7); the Bridge sets the add-in JSON-RPC `id` to that same string. Retire the client-side `Date.now()+random` id (SocketClient.ts:274-276). | One id from audit event (§5.1.4) through journal to the in-Revit task log (`McpTaskStatusService.BeginTask(request.Id,…)`, SocketService.cs:548-560). |
| P-O1-4 | **Idempotency key = `rsid/invocation_id`** (no separate key format); the journal is bridge-local SQLite (better-sqlite3, already an exact-pinned runtime dependency, installer/runtime-mcp-server/package.json:75-84). | Reuses the shipped native store; UUIDv7 gives time-ordered uniqueness without a new namespace. |
| P-O1-5 | **Serial-per-Revit-session becomes a protocol invariant**: in-flight window = 1 invoke/invoke_batch per registered Revit session (`rsid`), enforced at the Gateway dispatcher and asserted by the Bridge. Replaces the same-machine-only filesystem lock dirs (ConnectionManager.ts:43-46, 276-321). | The current serialization is tmpdir-mkdir based and cannot survive relocation of the runtime to the Gateway; the hard constraint ("serial per session") belongs in the protocol. |
| P-O1-6 | **Retire the per-command `mcp_status` preflight** (2 TCP round-trips per tool call today, SocketClient.ts:279-304, 3 s cap :287). Busy/active-task state instead rides heartbeats (`revit_status` block) and a `revit_busy` retryable fault when a user/other client occupies the session. | Removes a fixed 1-RTT tax per invocation; window=1 (P-O1-5) already prevents self-inflicted busy states. |
| P-O1-7 | **`invoke_batch` semantics are specified now; atomic execution ships later.** Bridges advertise capability `batch_atomic`; until the add-in gains an `execute_batch` command (one TransactionGroup per §5.2.4), the Bridge executes batches sequentially (`atomic:false` accepted, `atomic:true` rejected with `unsupported`). | Unblocks the pilot with an unchanged add-in and RevitMCPSDK while freezing the wire shape. |
| P-O1-8 | **Structured error model** = `retryable` boolean + `fault_class` enum + optional `guarded` passthrough. The add-in's three result outcomes — JSON-RPC error, guarded result, failure-shaped success (SocketService.cs:577-604, 758-833) — are surfaced distinctly, never flattened to strings as the current client does (SocketClient.ts:359-361). | §5.2's failure semantics (retryable vs terminal, parameter vs environment fault) and D12 guardrails need structure the JSON-RPC codes lack. |
| P-O1-9 | **Version negotiation:** integer protocol version + named capability flags in `hello`; the Gateway supports RBP v(N) and v(N−1) simultaneously. | Bridges self-update on a staged rollout (O9); a two-version support window is the cheapest compat rule that survives it. |
| P-O1-10 | **Legacy raw-JSON framing is not carried into the Bridge.** The Bridge speaks length-prefixed only on the add-in hop; the auto-detect/downgrade shims (SocketClient.ts:316-339, 97-111; SocketService.cs DetectMessageFraming :416-439 stays for back-compat but is never exercised). | The hard cutover replaces every runtime at once (D11); the legacy path is a cutover-era shim per the E2 map. |
| P-O1-11 | **`doc_context_update` is bridge-pushed but poll-derived in Phase 1**: initial snapshot at `session_register`, refresh after every completed invocation and on a 30 s idle poll of `get_current_view_info`/`list_open_views`. | No add-in eventing exists; polling two cheap read commands is sufficient for §5.2 stage-1 context assembly without touching the add-in. |
| P-O1-12 | **One Bridge process per machine, N Revit sessions**: the Bridge discovers local Revit instances by port scan 8080-8085 + `mcp_status` probe (the add-in auto-increments ports on conflict, SocketService.cs:149-185; scan mirrors ConnectionManager.ts:263-265) and registers each as a separate `rsid`. The `%TMP%/revAgent-instances.json` registry file (ConnectionManager.ts:37-42) is not relied on — nothing in the repo writes it. | Matches how multi-session machines actually work today; avoids depending on an unwritten registry file. |

---

## (b.1) RBP/1 Draft Specification (normative content for the spec document)

### 1. Transport & connection lifecycle

**Transport.** `wss://gateway.<domain>/bridge/v1` (DNS name, never IP — §7). Outbound-only dial from the Bridge. TLS verified against public CA. Device token presented at the HTTP upgrade: `Authorization: Bearer <device_token>` plus `X-RBP-Versions: 1` (pre-negotiation hint). A rejected upgrade returns HTTP 401 (bad/revoked token), 403 (seat/license refusal — §5.1.4), or 426 + JSON body `{min_protocol, max_protocol, manifest_url}` (protocol too old → O9 update path).

**Lifecycle states (Bridge FSM):** `idle → connecting → authenticating (upgrade) → hello-exchange → registered (per rsid) → steady ⇄ degraded → resuming | re-enrolling | backoff`.

1. **Enroll (one-time, out of band for RBP):** installer obtains a `device_token` (opaque, ≥256-bit) bound to `(tenant, machine fingerprint)`; storage/issuance is O3. RBP/1 only consumes it.
2. **Hello exchange (first frames after upgrade):** Bridge sends `hello`, Gateway answers `hello_ack` selecting the protocol version and echoing granted capabilities. Any other first frame → close 4400.
3. **Session registration:** one `session_register` per discovered Revit instance (P-O1-12) carrying user identity, machine, Revit/add-in/bridge versions, and open documents. Gateway replies `session_registered` with `rsid` + `resume_token`.
4. **Heartbeat:** Bridge → Gateway `heartbeat` every **15 s** per connection (not per rsid), carrying per-rsid status. Gateway replies `heartbeat_ack` (cumulative acks piggybacked). Gateway marks a bridge **degraded at 35 s** silence and **disconnected at 65 s** (sessions become resumable, pending invocations held). Bridge treats a missing `heartbeat_ack` for **10 s** as a dead link → close + reconnect. These intervals deliberately sit under common corporate-proxy idle timeouts (60 s) and Cloudflare-tunnel idle limits.
5. **Reconnect backoff:** initial 1 s, factor 2, cap 60 s, full jitter (`delay = rand(0, min(cap, base·2^n))`), counter reset after 120 s of stable connection. Note: nothing like this exists today — the runtime opens a fresh socket per tool call with no retry (ConnectionManager.ts:323-366, connect timeout 5 s :354, `disconnect()` in `finally` :363); backoff is net-new Bridge logic.
6. **Session resume:** on reconnect the Bridge sends `session_resume {rsid, resume_token, last_rx_seq}` per rsid instead of `session_register`. Gateway validates the token, replies `resume_ack {last_rx_seq}`, and both sides retransmit data frames with seq greater than the peer's acked seq. Redelivered `invoke`s are answered from the journal (§4 below). **Resume windows:** pending invocations are held by the Gateway for **10 min** after disconnect (then failed with retryable `environment` fault so the orchestrator can decide); an `rsid` registration survives **24 h** before a full `session_register` is required. Resume across Gateway restarts works because session state lives in Postgres (§5.2 "statelessness", §5.9).
7. **Shutdown:** `goodbye {reason}` then TLS close. Revit exit → Bridge sends `session_unregister {rsid}`; Gateway fails any pending invocation with terminal `environment` fault.

### 2. Message envelope

One JSON object per WS text frame:

```json
{
  "v": 1,                      // protocol version (int, fixed after hello)
  "type": "invoke",            // message type (enum below)
  "id": "0197a3c2-…",          // envelope id, UUIDv7 (minted by sender)
  "rsid": "rs_7f3a…",          // Revit session id; absent on connection-scoped control frames
  "seq": 412,                  // uint64, per-rsid per-direction, monotonic ACROSS reconnects; data frames only
  "ack": 409,                  // cumulative ack of peer's data seq for this rsid; optional, piggybacked
  "ts": "2026-07-20T12:00:00.000Z",
  "payload": { }               // type-specific body (schemas below)
}
```

Rules: unknown top-level or payload fields MUST be ignored (additive evolution); `seq`/`ack` appear only on data frames (`invoke|invoke_batch|result|partial|error|cancel|doc_context_update`); control frames (`hello|hello_ack|session_*|resume_*|heartbeat*|manifest*|goodbye`) are unsequenced and never retransmitted. Ordering authority is `seq`, never `ts` (clock skew tolerated). JSON Schemas live at `schemas/rbp/v1/*.schema.json`, validated with ajv exactly like the existing spatial page contracts (installer/runtime-mcp-server/schemas/spatial/v0.1-v0.3 + src/spatial/spatialPageSchema.ts pattern).

### 3. Message types

| Type | Dir | Payload (essentials) |
|---|---|---|
| `hello` | B→G | `{min_protocol:1, max_protocol:1, capabilities:["journal_v1","chunked_results"], bridge_version, machine:{hostname, os, fingerprint}, addin_versions:[…]}` — `batch_atomic` added when the add-in gains `execute_batch` |
| `hello_ack` | G→B | `{protocol:1, granted_capabilities:[…], heartbeat_interval_ms:15000, limits:{…see §5}, manifest:{latest_bridge_version, manifest_url}}` (O9 touchpoint at connect time) |
| `session_register` | B→G | `{user:{id, display}, machine, revit:{version, build}, addin_version, documents:[{title, path_digest, is_workshared, is_active}], port}` |
| `session_registered` | G→B | `{rsid, resume_token, seat:{granted:true}}` — seat refusal is an `error` with `fault_class:"auth"`, terminal |
| `session_resume` / `resume_ack` | B→G / G→B | `{rsid, resume_token, last_rx_seq}` / `{rsid, last_rx_seq}` |
| `session_unregister` | B→G | `{rsid, reason}` |
| `heartbeat` | B→G | `{sessions:[{rsid, revit_status:{active_task:{name, method, elapsed_ms} | null, port}}], bridge_version}` — `active_task` sourced from the add-in `mcp_status` snapshot (`McpTaskStatusService.GetSnapshot`, McpTaskStatusService.cs:187-196; `_activeTask` :118) polled locally by the Bridge |
| `heartbeat_ack` | G→B | `{acks:[{rsid, seq}], update_available?:{version, manifest_url}}` (O9 staged-rollout nudge) |
| `invoke` | G→B | `{invocation_id, method, params, timeout_ms:120000, mutating:bool, policy_class:"auto"|"confirm"|"gated", display:{task_name?, logical_tool_name?, parent_task_id?…}}` — `method`/`params` are the add-in JSON-RPC method and params **verbatim**; `mutating` + `policy_class` come from the Tool Registry (D12) and drive journal rules; `display` maps 1:1 onto the add-in's recognized side-channel params `taskName|wrapperAction|logicalToolName|parentTaskName|parentTaskId|suppressTaskStatusWindow` (SocketService.cs:539-547) which the Bridge merges into `params` exactly as the runtime tools do today (e.g. send_code_to_revit.ts:93-115) |
| `invoke_batch` | G→B | `{batch_id, atomic:bool, steps:[{invocation_id, method, params, mutating}], timeout_ms}` — `atomic:true` ⇒ one Revit transaction group via the future `execute_batch` add-in command; requires capability `batch_atomic`, else `error{fault_class:"unsupported", retryable:false}`. `atomic:false` ⇒ Bridge executes steps sequentially, stops at first failure, reports `failed_step_index`; each step journaled individually |
| `result` | B→G | `{invocation_id, status:"completed"|"guarded", result, guarded_reason?, replayed?:bool, payload_omitted?:bool, metrics:{execute_ms, response_bytes, framing:"length-prefixed"}}` — `result` is the add-in payload verbatim including `resultContractVersion:2` camelCase stamping (BridgeResultContract.cs:10, 25-40); `guarded` mirrors the add-in's guarded classification (SocketService.cs:577-585) so the Gateway policy layer (D12 `confirm` flows) sees it |
| `partial` | B→G | `{invocation_id, kind:"chunk"|"progress", chunk_index?, total_size?, data?, progress?:{elapsed_ms, note}}` — chunks ≤1 MiB, ordered, terminated by the `result` frame carrying `{chunked:true, total_chunks, sha256}`; `progress` emitted every 10 s during long add-in waits so the Gateway can distinguish slow from dead |
| `error` | B→G (invocation) or either dir (protocol) | `{invocation_id?, retryable:bool, fault_class, message, addin_error?:{code, message}}` — see taxonomy below |
| `cancel` | G→B | `{invocation_id}` — best-effort: the add-in hop has **no abort** (ExternalEvent handlers block until completion, e.g. ExecuteCodeCommand.cs:38-48); the Bridge marks the invocation abandoned, suppresses the late add-in result (journals the real outcome), and replies `error{fault_class:"cancelled", retryable:false}`. Spec states this limitation explicitly |
| `doc_context_update` | B→G | `{rsid, documents:[…], active_document, active_view:{id, name, type, level?}, discipline_hint?}` — per P-O1-11, sourced from `get_current_view_info` + `list_open_views` |
| `manifest_check` / `manifest_info` | B→G / G→B | `{bridge_version, channel}` / `{latest_version, min_supported_version, artifact_url, signature, rollout_cohort}` — shapes owned here, semantics owned by O9 (detached RS256 signing per existing signed-source-free-cd.yml convention) |
| `goodbye` | either | `{reason:"shutdown"|"update"|"protocol_error", detail?}` |

**Error taxonomy (`fault_class`):** `protocol` (malformed/seq violation; terminal, closes connection), `auth` (token/seat; terminal), `unsupported` (method or capability; terminal — maps add-in `MethodNotFound`, SocketService.cs:531-533), `parameter` (bad params; terminal — maps `InvalidRequest`/`ParseError` :515-520, 627-635), `revit_busy` (user or other client active; **retryable**), `revit_timeout` (add-in exceeded `timeout_ms`; retryable for `mutating:false`, indeterminate handling for `mutating:true` — §4), `revit_api` (command threw; maps `InternalError` :611 and failure-shaped results :587-596; terminal to the loop, surfaced to the model per §5.2.5), `addin_unreachable` (TCP connect/reset; retryable), `journal_indeterminate` (terminal; requires verification read), `oversize` (terminal), `cancelled` (terminal). This taxonomy is the §5.2 "structured errors (retryable vs terminal, parameter vs environment fault)" contract.

### 4. Idempotency journal semantics

- **Store:** SQLite (better-sqlite3) at the Bridge, one DB per device: `journal(rsid TEXT, invocation_id TEXT, batch_id TEXT NULL, method TEXT, mutating INT, state TEXT CHECK(received|executing|completed|failed|guarded|cancelled), params_digest TEXT, result BLOB NULL, result_digest TEXT, created_at, finished_at, PRIMARY KEY(rsid, invocation_id))`. WAL mode; the `received` row is **fsynced before the first byte reaches the add-in socket**; the outcome row is committed **before** the `result`/`error` frame is sent to the Gateway. Crash between add-in completion and outcome commit therefore lands in `executing` = indeterminate — safe by construction.
- **Key:** `(rsid, invocation_id)`; batch steps use their own `invocation_id`s plus shared `batch_id`; an `atomic:true` batch additionally journals one batch-level row whose outcome is all-or-nothing (transaction-group assumption).
- **Redelivery answer rules** (applied on any `invoke` whose key exists — the resume path and duplicate-seq path both funnel here):
  1. State `completed|failed|guarded|cancelled` → replay the stored outcome with `replayed:true`. Stored result payloads are capped at 1 MiB; beyond that the journal keeps `result_digest` only and the replay carries `payload_omitted:true` — the Gateway must then re-query state via a read tool rather than trust a lost payload.
  2. State `received|executing` (indeterminate) and `mutating:false` → re-execute once (after confirming the add-in is idle via `mcp_status`), overwrite the row.
  3. State `received|executing` and `mutating:true` → **never re-execute**; answer `error{fault_class:"journal_indeterminate", retryable:false}`. The orchestrator must run a verification read ("LLM proposes, engine verifies", D12) before any retry with a **new** invocation id. This is the primary defense against duplicate model mutations on flaky links (§5.4).
  4. `params_digest` mismatch on an existing key → `protocol` fault (id reuse bug upstream).
- **Retention:** 7 days or 50,000 rows, whichever first; pruned on Bridge start and hourly. Journal survives Bridge restarts and self-updates (O9 must preserve the DB path).

### 5. Flow control & size limits (aligned with the existing 8192-fix framing constraints)

| Limit | Value | Alignment |
|---|---|---|
| In-flight window per `rsid` | **1** invoke or invoke_batch | Hard constraint "serial per session"; replaces lock dirs + preflight (P-O1-5/6). Violation ⇒ `protocol` fault. Distinct rsids and control frames are unconstrained |
| `invoke`/step params (serialized) | ≤ 4 MiB | Safely under the add-in default message cap of 16 MiB / absolute 128 MiB via `REVAGENT_MAX_MESSAGE_BYTES` (SocketService.cs:19-21, 67-76); Bridge pre-rejects locally with `oversize` before touching the add-in, mirroring the add-in's own oversize error + connection abort behavior (:281-290, 344-352) |
| `partial` chunk | ≤ 1 MiB | Keeps WS frames proxy-friendly; Bridge chunks after reading the full add-in response |
| Total result per invocation | ≤ 32 MiB | Matches the current client cap `MAX_RESPONSE_BYTES` (SocketClient.ts:4) and the add-in's re-framed accumulation (SocketService.cs:243-313); larger results are a Gateway result-hygiene concern (`result_ref`, §5.2.5), not a protocol concern |
| Control frames / `doc_context_update` | ≤ 64 KiB / ≤ 256 KiB | Heartbeats must never queue behind data |
| Default `timeout_ms` | 120,000 | Matches today's client default (SocketClient.ts:378); Gateway-side deadline = `timeout_ms` + 10 s grace. Per-command ExternalEvent waits inside the add-in (15 s–60 s, e.g. GetSelectedElementsCommand.cs:39, ExecuteCodeCommand.cs:41) remain the inner bound |

Backpressure: with window=1 per rsid, data-plane backpressure is structural; the Bridge additionally pauses chunk emission when the WS socket's buffered amount exceeds 8 MiB.

### 6. Versioning & compatibility

- `hello.min_protocol/max_protocol` (ints); Gateway selects `protocol` in `hello_ack`; no overlap ⇒ close 4426 + manifest pointer (upgrade path).
- Within a version: additive-only changes (new optional fields, new capability-gated message types); unknown fields ignored. Breaking changes bump the integer.
- Gateway supports v(N) and v(N−1) (P-O1-9). Bridge capability flags (`batch_atomic`, `chunked_results`, `transport_fallback`) gate optional behavior inside a version.
- The add-in hop keeps its own independent contract (`resultContractVersion:2`, BridgeResultContract.cs:10); RBP passes it through opaquely — the two versions never couple.

### 7. Command pass-through mapping (add-in hop unchanged)

The Bridge forwards `method` + `params` verbatim over the existing length-prefixed TCP framing (4-byte BE header — write: SocketClient.ts:396-406; read: SocketService.cs:336-367, 446-452; response write :454-468), with JSON-RPC `id` = `invocation_id` (P-O1-3). All 21 registered commands (command.json:10-116) + `mcp_status`:

| Category | Commands | `mutating` (journal) | Default policy class (D12, owned by Tool Registry) | Notes |
|---|---|---|---|---|
| Context reads | `get_current_view_elements`, `get_current_view_info`, `get_selected_elements`, `get_ui_state`, `list_open_views` | false | `auto` | `get_current_view_info` + `list_open_views` double as the `doc_context_update` source (P-O1-11) |
| Inspection/query | `find_elements`, `inspect_levels`, `inspect_sheet_text`, `inspect_schedules`, `count_annotations` | false | `auto` | Wide parameterized shape already matches §5.3 |
| Spatial | `extract_spatial_snapshot`, `get_spatial_change_state` | false | `auto` | Paged multi-invoke sequences; `suppressTaskStatusWindow` side-channel honored (SocketService.cs:544-547) |
| UI navigation (no model write) | `activate_view`, `close_view`, `clear_selection`, `focus_elements`, `open_existing_plan_for_element_level` | false (re-execution harmless) | `auto` | Idempotent by nature; journal rule 2 applies |
| Model writes | `create_3d_view_for_elements` (Transaction, Create3DViewForElementsEventHandler.cs:319), `section_box_elements` (SectionBoxElementsEventHandler.cs:270), `delete_review_view` (DeleteReviewViewEventHandler.cs:213) | **true** | `auto`/`confirm` per registry | Journal rule 3 (never blind re-execute) |
| Dynamic code | `send_code_to_revit` | **true** always | `confirm` (raw) / `auto` behind the safe wrapper's regex guards (send_code_to_revit_safe_guards.ts:1-27, send_code_to_revit_safe.ts:33-52) | Auto/manual transaction detection stays add-in-side (ExecuteCodeEventHandler.cs:56, 137, 146); future `execute_batch` must reject inner `TransactionGroup` in step code |
| Pseudo | `mcp_status` (served without registry dispatch, SocketService.cs:522-526) | false | n/a | Absorbed into heartbeat `revit_status`; stays invocable for diagnostics only |

The Bridge does **not** port: the legacy-JSON fallback (P-O1-10), the loose correlation that broadcasts unmatched errors to all pending callbacks (SocketClient.ts:223-238 — with window=1 and exact id matching this hole closes), or the busy preflight (P-O1-6).

### 8. Minimal conformance test list (pilot gate)

Runs bridge-simulator vs gateway-stub vs add-in loopback fixture; ✅ = required green before D11 step 2 (pilot).

1. ✅ Handshake happy path: upgrade auth, hello negotiation, session_register per discovered instance, capability grant.
2. ✅ Version mismatch → 426/close-4426 with manifest pointer; no reconnect storm.
3. ✅ Bad/revoked device token → 401, backoff honored (measured delays within jitter envelope).
4. ✅ Heartbeat liveness: dropped acks → bridge reconnects; gateway transitions degraded(35 s)/disconnected(65 s).
5. ✅ Reconnect + resume: seq retransmit both directions; completed invocation answered from journal with `replayed:true`; fixture asserts exactly one add-in execution.
6. ✅ Indeterminate + `mutating:true` → `journal_indeterminate`, zero re-executions (kill bridge-sim between add-in completion and outcome commit).
7. ✅ Indeterminate + `mutating:false` → exactly one re-execution.
8. ✅ Serial window: 2nd invoke on same rsid while 1st in-flight → `protocol` fault; parallel invokes on two rsids succeed.
9. ✅ Chunked result: 20 MiB fixture payload → ordered partials ≤1 MiB, sha256 verified on reassembly.
10. ✅ Oversize both directions: >4 MiB params rejected bridge-side without add-in traffic; >32 MiB result → `oversize` terminal.
11. ✅ Timeout & busy: stalled fixture → `revit_timeout` with correct retryability by `mutating`; fixture `mcp_status` activeTask → `revit_busy` retryable.
12. ✅ Cancel: mid-invoke cancel → `cancelled`; late fixture result suppressed but journaled.
13. ✅ Error mapping: fixture returns MethodNotFound / InvalidRequest / InternalError / guarded-result / failure-shaped-result → correct `fault_class` + `guarded` passthrough.
14. ✅ Framing golden vectors on the add-in hop: 4-byte BE header byte-exact vs SocketService rules; legacy raw JSON never emitted; split-across-reads and multiple-messages-per-read reassembly (the 8192-fix cases).
15. ✅ Batch sequential: `atomic:false` executes in order, halts at failing step, reports `failed_step_index`; `atomic:true` without `batch_atomic` → `unsupported`.
16. ✅ doc_context_update: fixture document change surfaces within one poll interval; register carries the initial document list.
17. ✅ Duplicate-frame delivery (same seq replayed) → exactly-once effect via journal.
18. Manifest: heartbeat_ack `update_available` acknowledged (apply is O9). *(required for cutover, not pilot)*
19. Batch atomic with transaction-group assertion. *(activates when `execute_batch` lands)*

---

## (c) Work Breakdown

Estimates: one senior dev + AI coding assistant, in dev-days.

| ID | Task | Depends on | Acceptance criteria | Est. |
|---|---|---|---|---|
| O1-T1 | **Spec document + JSON Schemas.** Write `docs/protocol/rbp-v1.md` from §(b.1) above and author `schemas/rbp/v1/*.schema.json` (envelope + every payload), following the existing versioned-schema-dir + ajv pattern (installer/runtime-mcp-server/schemas/spatial/, src/spatial/spatialPageSchema.ts). Includes the error-taxonomy table, limits table, and the 21-command mapping table. | — | Doc reviewed & merged; every message type has a schema; schemas validate the golden-vector corpus; mapping table covers all entries of command.json:10-116 + `mcp_status`. | 3 |
| O1-T2 | **Shared protocol library** `packages/rbp-protocol` (TS, ESM, strict — same tsconfig conventions as installer/runtime-mcp-server/tsconfig.json): envelope encode/decode, ajv validation, seq/ack bookkeeping, and pure-logic FSMs (connection lifecycle, invocation lifecycle, journal state machine) with zero I/O so both Bridge and Gateway import them. | O1-T1 | Unit tests green; FSMs are side-effect-free and property-tested; package consumed by T4 and T5 without duplication. | 3 |
| O1-T3 | **Add-in loopback fixture:** Node TCP server implementing the add-in's exact framing behavior (length-prefixed 4-byte BE, 16 MiB default cap + oversize error-then-abort per SocketService.cs:281-290/344-352, `mcp_status` snapshot shape from McpTaskStatusService.cs:187-196, `resultContractVersion:2` results) with scriptable modes: delay, stall, error codes, guarded result, failure-shaped result, activeTask busy, mid-response disconnect. | O1-T1 | Fixture passes the framing golden vectors; every conformance test's fixture mode exists; runs on Linux CI with no Revit. | 1.5 |
| O1-T4 | **Bridge simulator:** headless Bridge built on rbp-protocol + a persistent-connection rework of `RevitClientConnection` (reuse framing/write paths SocketClient.ts:185-211/396-406; delete preflight, legacy fallback, loose correlation), plus the reference **idempotency journal** (better-sqlite3, schema + fsync ordering per §4), chunking, discovery scan (P-O1-12), heartbeat/backoff/resume FSM wiring. This simulator is the seed of the production Bridge core. | O1-T2, O1-T3 | Registers N fixture instances as rsids; survives kill -9 with correct indeterminate classification; journal rules 1–4 demonstrably enforced; no filesystem locks used. | 3 |
| O1-T5 | **Gateway stub:** `ws`-based server (note: `ws ^8.20.1` is already a declared-but-unused runtime dep, installer/runtime-mcp-server/package.json — reuse it here and drop it from the runtime) implementing upgrade auth (static token table), hello negotiation, session/rsid table, window=1 dispatcher, resume/retransmit, and a fault-injection control API (drop frames, delay acks, force disconnect, duplicate frames). | O1-T2 | Enforces serial window and seq rules; fault-injection API drives tests 4–7, 12, 17; in-memory state only (Postgres wiring belongs to the Gateway package). | 2 |
| O1-T6 | **Conformance suite + CI:** implement tests 1–17 of §8 against T3/T4/T5; wire into .github/workflows/ci.yml (Linux job, no Revit, no self-hosted runner needed); nightly 1 h reconnect-churn soak job. | O1-T3, O1-T4, O1-T5 | Tests 1–17 green and deterministic (3 consecutive clean runs); suite runtime < 10 min; churn soak leak-free (fd/memory flat). | 3 |
| O1-T7 | **Real add-in interop smoke** (manual, Windows dev workstation with Revit — the `revagent-cd` self-hosted runner machine if it has Revit, else a dev seat): run the bridge simulator against a live add-in; execute one command per mapping-table category incl. a `send_code_to_revit` write and a mid-command bridge kill/resume; verify in-Revit task-status window shows the gateway-minted invocation id. | O1-T6 | All categories round-trip with `resultContractVersion:2` intact; indeterminate write handled per journal rule 3 against real Revit; no add-in code changed. | 1 |
| O1-T8 | **Ratification & freeze:** fold interop findings back into spec + schemas, tag `rbp/v1.0.0`, publish the protocol-version constant from rbp-protocol, and produce the pilot-gate checklist (tests 1–17 green + T7 sign-off) referenced by the D11 step-2 entry in the master plan. | O1-T7 | Spec marked frozen; any later change requires the P-O1-9 versioning rules; master plan pilot gate links to the checklist. | 1 |

**Package total: 17.5 dev-days.** Critical path: T1 → T2 → T4 → T6 → T7 → T8.

---

## (d) Test Strategy

- **Golden vectors (unit):** byte-exact corpora for (i) RBP envelopes vs JSON Schemas, (ii) add-in framing — header encoding, split reads, coalesced messages, oversize — derived from SocketService.cs:243-313/336-367/446-468 and SocketClient.ts:185-211. These vectors are the contract artifact that survives future ports (e.g. a Rust/.NET bridge).
- **Property-based tests** (fast-check) on the pure FSMs from O1-T2: arbitrary interleavings of {deliver, duplicate, drop, reorder-across-reconnect, crash} must never yield double-execution of a `mutating:true` invocation and must always converge journal state to a terminal classification.
- **Conformance matrix (integration):** §8 list, three-process harness (fixture + simulator + stub) on Linux CI; every test asserts both wire behavior and journal/DB ground truth (execution counts asserted at the fixture, not inferred).
- **Fault injection:** stub control API + OS-level actions (SIGKILL the simulator, `socket.destroy()` for RST, half-open by suspending the stub) — specifically covering the crash window between add-in completion and journal outcome commit.
- **Soak:** nightly 1 h reconnect churn in CI; a 24 h soak on office hardware through the real Cloudflare-style tunnel is a pre-pilot exit criterion (validates heartbeat intervals vs real proxy idle timeouts).
- **Real interop:** O1-T7 on Windows with live Revit — the only test tier that exercises ExternalEvent timing truths (per-command 15–60 s waits, UI-thread serialization) that fixtures can't emulate.
- **Negative security:** revoked token mid-connection, resume with another rsid's `resume_token`, cross-rsid invoke, params-digest mismatch on key reuse — all must fail closed with `auth`/`protocol` faults.
- **CI placement:** all tiers except O1-T7 run on standard Linux runners inside ci.yml; nothing in this package touches the `revagent-cd` Windows runner or the signed CD pipeline (those are exercised by the Bridge-product and O9 packages).

---

## (e) Risks Specific to This Package

1. **RevitMCPSDK is external and version-locked** (`RevitMCPSDK:$(RevitVersion).*`, revAgentPlugin.csproj:46): any temptation to "improve" the add-in hop (e.g., JSON-RPC envelope tweaks) drags in an SDK we don't own. Mitigation: P-O1-3/P-O1-10 keep the hop byte-compatible; `execute_batch` is deferred and additive (new command, no SDK type changes).
2. **Indeterminate-write friction in the pilot:** journal rule 3 converts some flaky-link retries into "verify then retry" round-trips; over-triggering will read as flakiness to pilot users. Mitigation: fsync ordering minimizes the indeterminate window; pilot telemetry counts `journal_indeterminate` occurrences as an explicit pilot metric with a tuning review.
3. **Corporate proxy/TLS-inspection behavior vs long-lived WSS:** idle resets, 60 s idle timeouts, or WS-hostile middleboxes could force the deferred Streamable-HTTP fallback into Phase 1. Mitigation: 15 s heartbeats sit under common timeouts; the 24 h soak through the real tunnel is a go/no-go gate; envelope is transport-agnostic so the fallback is additive if needed.
4. **Add-in listens on all interfaces with no auth** (`TcpListener(IPAddress.Any, port)`, SocketService.cs:157): once the Bridge is the only intended client, any LAN peer can still drive Revit directly, bypassing Gateway policy/audit. Not O1 scope, but O1 makes it the *only* unaudited path. Mitigation: flagged as a mandatory change in the add-in adaptation package (bind loopback by default, env opt-out); the spec notes the Bridge always connects to `127.0.0.1`.
5. **Concurrent non-Bridge clients during migration:** singleton command instances race on handler parameter state under multiple clients (defended in GetSelectedElementsCommand.cs:16/28; undefended in ExecuteCodeCommand) and the old runtime's tmpdir locks don't see the Bridge. Window=1 protects only Bridge traffic. Mitigation: cutover runbook (D11 step 3) removes old runtimes before the Bridge goes live per machine; pilot machine runs Bridge-only.
6. **Known add-in wait race** — `ExecuteCodeEventHandler.WaitForCompletion` resets the event before waiting (ExecuteCodeEventHandler.cs:43-47), which can drop an already-signaled completion and will surface as spurious `revit_timeout` under the conformance timing tests. Mitigation: documented as an add-in adaptation fix; conformance test 11 tolerances set so the protocol layer isn't blamed for it.
7. **Instance discovery ambiguity on multi-Revit machines:** the port-scan + `mcp_status` probe (P-O1-12) can misattribute rsids if a non-RevAgent service squats 8080-8085. Mitigation: registration requires a valid `mcp_status` snapshot shape + add-in version echo; mismatches are logged and skipped.
8. **Scope creep toward O3/O9:** enrollment backends and update plumbing are adjacent and tempting. Mitigation: hard non-goals list in §(a); the stub's static token table and manifest message shapes are the contractual maximum this package builds.

**Key files for the implementing engineer:** /home/user/revAgent/docs/TARGET_ARCHITECTURE.md (§5.4, 5.7, 8, 10/O1); /home/user/revAgent/installer/runtime-mcp-server/src/utils/SocketClient.ts; /home/user/revAgent/installer/runtime-mcp-server/src/utils/ConnectionManager.ts; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/SocketService.cs; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/BridgeResultContract.cs; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/McpTaskStatusService.cs; /home/user/revAgent/src/revit-plugin/revAgentCommandSet/command.json; /home/user/revAgent/installer/runtime-mcp-server/schemas/ (schema-versioning pattern to copy).