> Part of the RevAgent implementation plan (see `00-INDEX.md`).
> Normativity: `docs/TARGET_ARCHITECTURE.md` → `00-INDEX.md` resolutions (RES-*/GAP-*) → this section.
> Where this section conflicts with a resolution in `00-INDEX.md`, the index wins.

# Package P1 — O1: Bridge↔Gateway Internal RPC Protocol ("RBP/1") — v1.0 Freeze-Candidate Plan

Protocol name used throughout: **RBP/1** (RevAgent Bridge Protocol, version 1). This is the D4 "internal RPC" hop (Gateway ↔ Bridge, NOT MCP). Per TARGET_ARCHITECTURE.md §10/O1 this is the **first deliverable and the precondition for the D11 pilot**.

---

## (a) Scope & Non-Goals

**In scope**
- The normative wire protocol between Gateway and thin desktop Bridge: transport, connection lifecycle (enroll/auth/register/heartbeat/reconnect/resume), message envelope, message types, error taxonomy, idempotency-journal semantics, flow control and size limits, version negotiation.
- The O9 *touchpoint only*: the version/manifest-check message shapes ride RBP/1; the update download/verify/apply mechanism itself is O9.
- An explicit pass-through mapping for the existing add-in command families, the `mcp_status` pseudo-method,
  and the RES-3/4 pre-pilot adaptations, preserving the add-in hop's length-prefixed framing byte-compatibly.
- A conformance harness (bridge simulator + gateway stub + add-in loopback fixture) runnable in Linux CI without Revit, plus one real-add-in interop smoke.

**Non-goals (owned elsewhere in the master plan)**
- Bridge product implementation (installer, service wrapper, tray UI) and self-update apply logic (O9 package).
- Enrollment/auth backend, tenant/user/device data model (O3/O5) — RBP/1 defines only the token presentation and claims consumed at handshake.
- Gateway orchestration engine, tool registry, MCP north surface, result-hygiene/`result_ref` store (§5.2/5.9 packages) — RBP/1 defines only how raw results arrive at the Gateway.
- Add-in implementation work or a RevitMCPSDK change. Per RES-5, however, the pilot uses the adapted add-in and O1 specifies the required loopback-only listener, `execute_batch`, `get_document_context`, and capability/version contract; WP3 implements and proves those changes before pilot entry.
- Feature work of any kind (feature freeze per §8).

---

## (b) Plan-Level Design Decisions

| ID | Decision | Rationale (one line) |
|---|---|---|
| P-O1-1 | Per RES-25/DP-2, **WSS is primary and Streamable HTTP/SSE is a required Phase-1 fallback** behind `transport_streamable_http`. The exact create/events/messages lifecycle and opening-error matrix are frozen in the spec §4; both bindings share one RBP FSM, journal, resume, and conformance corpus. | Preserves the simplest normal path while surviving WS-hostile proxies without creating a second semantic protocol. |
| P-O1-2 | One JSON object per WSS text frame, HTTP uplink request, or SSE `rbp` event; no custom RBP binary framing. Large results use `partial` chunks on either binding. | Keeps wire debugging and golden vectors transport-independent; SSE expansion never raises decoded-byte limits. |
| P-O1-3 | **Single correlation chain:** the Gateway mints `invocation_id` (UUIDv7); the Bridge sets the add-in JSON-RPC `id` to that same string. Retire the client-side `Date.now()+random` id (SocketClient.ts:274-276). | One id from audit event (§5.1.4) through journal to the in-Revit task log (`McpTaskStatusService.BeginTask(request.Id,…)`, SocketService.cs:548-560). |
| P-O1-4 | **Idempotency key = exact string `rsid + "/" + invocation_id`** (RES-21). Journal semantics require a bridge-local durable SQLite-class store but do not select a language/library (RES-2). | One stable audit/journal key survives the .NET Bridge implementation and staged reconnects. |
| P-O1-5 | **Serial-per-Revit-session becomes a protocol invariant**: in-flight window = 1 invoke/invoke_batch per registered Revit session (`rsid`), enforced at the Gateway dispatcher and asserted by the Bridge. Replaces the same-machine-only filesystem lock dirs (ConnectionManager.ts:43-46, 276-321). | The current serialization is tmpdir-mkdir based and cannot survive relocation of the runtime to the Gateway; the hard constraint ("serial per session") belongs in the protocol. |
| P-O1-6 | **Retire the per-command `mcp_status` preflight** (2 TCP round-trips per tool call today, SocketClient.ts:279-304, 3 s cap :287). Busy/active-task state instead rides heartbeats (`revit_status` block) and a `revit_busy` retryable fault when a user/other client occupies the session. | Removes a fixed 1-RTT tax per invocation; window=1 (P-O1-5) already prevents self-inflicted busy states. |
| P-O1-7 | **`invoke_batch` has one result carrier and durable redelivery contract.** Every step carries raw `params` plus verified `params_digest`; one exact RFC 8785 `batch_digest` binds the complete ordered semantics. `atomic:false` stops at the first guarded/failed/cancelled/indeterminate step on first delivery or redelivery. `atomic:true` requires the per-session `batch_atomic` grant and one `execute_batch` transaction group; the adapted pilot stack must demonstrate it (RES-5). | Removes omitted-step/digest ambiguity, freezes mixed terminal/non-terminal results, and prevents a guarded or uncertain step from leaking into successor execution. |
| P-O1-8 | **Structured outcomes** = explicit `fault_class`/`retryable`/`outcome`/`verification_required` for top-level and nested errors and result status in `{completed, guarded}`. Guarded results require `guarded_reason`; replay-only `payload_omitted` requires a digest and read recovery. Indeterminate writes install an `(rsid,mutation_scope)` conflict hold with explicit verification/late-evidence correlation and evidence-bound clearance. | D12 protected behavior and unknown-write safety must be machine-testable, not flattened to strings, guessed booleans, or bypassed with a fresh invocation id. |
| P-O1-9 | **Version negotiation:** integer protocol version + named capability flags in `hello`; the Gateway supports RBP v(N) and v(N−1) simultaneously. | Bridges self-update on a staged rollout (O9); a two-version support window is the cheapest compat rule that survives it. |
| P-O1-10 | **Legacy raw-JSON framing is not carried into the Bridge.** The Bridge speaks length-prefixed only on the add-in hop; the auto-detect/downgrade shims (SocketClient.ts:316-339, 97-111; SocketService.cs DetectMessageFraming :416-439 stays for back-compat but is never exercised). | The hard cutover replaces every runtime at once (D11); the legacy path is a cutover-era shim per the E2 map. |
| P-O1-11 | Per RES-3, **`doc_context_update` is bridge-pushed from cached `get_document_context`**: initial snapshot plus 15 s poll and post-resume refresh; no standing `get_current_view_info`/`list_open_views` polling. | Add-in app events maintain the cache without repeated ExternalEvent/UI-thread work. |
| P-O1-12 | **One Bridge process per machine, N Revit sessions**: the Bridge discovers local Revit instances by port scan 8080-8085 + `mcp_status` probe (the add-in auto-increments ports on conflict, SocketService.cs:149-185; scan mirrors ConnectionManager.ts:263-265) and registers each as a separate `rsid`. The `%TMP%/revAgent-instances.json` registry file (ConnectionManager.ts:37-42) is not relied on — nothing in the repo writes it. | Matches how multi-session machines actually work today; avoids depending on an unwritten registry file. |
| P-O1-13 | **GAP-7 uses no general RBP `file_fetch` in Phase 1.** O1 defines only the Bridge→Gateway `artifact_result_v1` carrier: multiple output files get stable `artifact_id`/zero-based index mappings and independent chunk stream identities under one terminal result. Client upload, Gateway `artifact_ref`/resource ownership, and Codex Desktop delivery stay in WP2/WP9. | Prevents arbitrary workstation reads, makes multi-file output reconstructable without stream collisions, and keeps north-MCP semantics out of the internal RBP contract. |

---

## (b.1) RBP/1 Freeze-Candidate Summary

`docs/specs/O1-bridge-gateway-protocol.md` is the normative wire contract. This section summarizes the
implementation plan and must not introduce a divergent schema or lifecycle.

### 1. Transport & connection lifecycle

**Transport.** Primary = `wss://gateway.revagent.app/bridge/v1`; fallback = the spec §4.1 HTTPS
`POST /bridge/v1/http/connections` + authenticated SSE `.../{connection_id}/events` + JSON uplink
`.../{connection_id}/messages` lifecycle. Both are outbound-only, use the DNS name/public TLS validation,
`Authorization: Bearer <device_token>`, and `X-RBP-Versions`. WSS is tried first. Only a provisioned
`transport_streamable_http` capability permits one fallback attempt after a retryable network/proxy/upgrade
failure; auth/version/TLS failures never downgrade. HTTP/WSS opening failures follow the spec §4.2 matrix and
do not fabricate invocation outcomes.

**Lifecycle states (Bridge FSM):** `idle → connecting → authenticating (upgrade) → hello-exchange → registered (per rsid) → steady ⇄ degraded → resuming | re-enrolling | backoff`.

1. **Enroll (one-time, out of band for RBP):** installer obtains a `device_token` (opaque, ≥256-bit) bound to `(tenant, machine fingerprint)`; storage/issuance is O3. RBP/1 only consumes it.
2. **Hello exchange (first frames after upgrade):** Bridge sends `hello`, Gateway answers `hello_ack` selecting the protocol version and echoing granted capabilities. Any other first frame → close 4400.
3. **Session registration:** one `session_register` per discovered Revit instance (P-O1-12) carrying diagnostic user/machine data, Revit/add-in/bridge versions, `result_contract_version`, per-session capabilities, and bounded document objects. Gateway derives user/tenant/seat from enrollment and replies with `rsid`, resume token, principal/seat binding, and `granted_session_capabilities`; payload identity cannot self-authorize.
4. **Heartbeat:** Bridge → Gateway `heartbeat` every **15 s** per connection (not per rsid), carrying per-rsid status. Gateway replies `heartbeat_ack` (cumulative acks piggybacked). Gateway marks a bridge **degraded at 35 s** silence and **disconnected at 65 s** (sessions become resumable, pending invocations held). Bridge treats a missing `heartbeat_ack` for **10 s** as a dead link → close + reconnect. These intervals deliberately sit under common corporate-proxy idle timeouts (60 s) and Cloudflare-tunnel idle limits.
5. **Reconnect backoff:** zero-based full jitter: the first retry uses `n=0` and waits a uniform integer in `0..1000 ms`; later waits use `0..min(60000, 1000·2^n)`. A connection consumes the next index when it fails or leaves steady before 120 continuous seconds; only 120 continuous steady seconds reset to `n=0`. Auth/authorization/version/TLS refusals pause unchanged retries. This is net-new Bridge logic.
6. **Session resume:** on reconnect the Bridge sends `session_resume {rsid, resume_token, last_rx_seq}` per rsid instead of `session_register`. Gateway validates the token, replies `resume_ack {rsid,last_rx_seq,resume_expires_at}`, and both sides retransmit data frames with seq greater than the peer's acked seq. Redelivered `invoke`s are answered from the journal (§4 below). **Resume windows:** pending invocations are held for **10 min** and an `rsid` for **24 h**. Expired non-mutating work may return retryable `environment` only when concurrent execution is impossible. A possibly dispatched mutation returns non-retryable `journal_indeterminate` and installs the durable `(rsid,mutation_scope)` conflict hold checked before every fresh-id mutation; only correlated read/late evidence plus an audited, evidence-bound clearance can open that scope. Resume survives Gateway restart through durable state.
7. **Shutdown/unregistration:** `goodbye` closes a connection. Revit-session removal uses `session_unregister {rsid, reason}` where reason is `revit_exited|bridge_shutdown|session_replaced|operator_requested`; it revokes resume and prevents new dispatch. A known-not-dispatched pending call may become `addin_unreachable`; a possibly dispatched mutation remains indeterminate.

### 2. Message envelope

One JSON object per WSS text frame, fallback uplink request, or fallback SSE `rbp` event:

```json
{
  "v": 1,                      // protocol version (int, fixed after hello)
  "type": "invoke",            // message type (enum below)
  "id": "0197a3c2-…",          // envelope id, UUIDv7 (minted by sender)
  "rsid": "rs_7f3a…",          // Revit session id; absent on connection-scoped control frames
  "seq": 412,                  // exact JSON-safe integer 1..2^53-1, per-rsid per-direction; data only
  "ack": 409,                  // cumulative ack of peer's data seq for this rsid; optional, piggybacked
  "ts": "2026-07-20T12:00:00.000Z",
  "payload": { }               // type-specific body (schemas below)
}
```

Rules: `hello`/`hello_ack` omit top-level `v`; the latter selects `payload.protocol`, and every later object
requires that value as `v`. Unknown fields are ignored for additive evolution; data frames
(`invoke|invoke_batch|result|partial|error|cancel|doc_context_update`) require `rsid` and `seq` and may carry
`ack`. Control frames (`hello|hello_ack|session_*|resume_*|heartbeat*|manifest*|goodbye`) forbid `rsid`,
`seq`, and `ack` at the envelope level, are unsequenced, and are not retransmitted. Ordering authority is
`seq`, never HTTP/SSE order or `ts`. Values above `2^53-1`, fractions, unsafe exponent forms, and wrap are
protocol faults. JSON Schemas live at `packages/protocol/schemas/rbp/v1/*.schema.json` and generated types at
`packages/protocol/src/generated`; CI regenerates and requires a clean diff.

### 3. Message types

| Type | Dir | Payload (essentials) |
|---|---|---|
| `hello` | B→G | `{min_protocol, max_protocol, capabilities:["journal_v1","chunked_results","artifact_result_v1","transport_streamable_http"], bridge_version, device_id, machine, addin_versions:[…]}` — connection capabilities only; add-in-dependent grants are per session |
| `hello_ack` | G→B | `{protocol:1,connection_id,granted_capabilities:[…],heartbeat_interval_ms:15000,limits:{max_params_bytes,max_result_bytes,max_partial_bytes},manifest:{latest_bridge_version,manifest_url}}` (O9 touchpoint at connect time) |
| `session_register` | B→G | `{local_session_key,user_hint,machine,revit:{version,build,pid},addin_version,result_contract_version,session_capabilities:[…],bridge_version,documents:[{document_id,title,path_digest,is_workshared,is_active}],port}` — version/capabilities come from successful local probes, not inference; user hint cannot select principal/seat |
| `session_registered` | G→B | `{rsid,resume_token,resume_expires_at,principal:{tenant_id,user_id},seat:{granted:true,seat_id},granted_session_capabilities:[…]}` — Gateway derives authority from enrollment; mismatch/refusal is terminal `auth` |
| `session_resume` / `resume_ack` | B→G / G→B | `{rsid,resume_token,last_rx_seq}` / `{rsid,last_rx_seq,resume_expires_at}` |
| `session_unregister` | B→G | `{rsid,reason}` with reason in `{revit_exited, bridge_shutdown, session_replaced, operator_requested}` — both fields required; token revoked; unknown mutation remains indeterminate |
| `heartbeat` | B→G | `{bridge_version,acks:[{rsid,seq}],sessions:[{rsid,port,revit_status:{active_task,addin_reachable}}]}` where `active_task` is `null` or `{name,method,elapsed_ms}` — `port` is a session-row sibling of `revit_status`; status comes from the locally polled add-in `mcp_status` snapshot |
| `heartbeat_ack` | G→B | `{server_time,acks:[{rsid,seq}],update_available?:{channel,manifest_url}}` — `server_time` and `acks` are required; the update channel is explicit (O9 staged-rollout nudge) |
| `invoke` | G→B | `{invocation_id,method,params,timeout_ms:120000,mutating,mutation_scope,policy:{class,decision,confirmation_id},verification,recovery_clearances:[…],display:{task_name?,logical_tool_name?,parent_task_id?…}}` — the nested policy block is registry/dispatcher-authored; scope/verification/clearance fields follow spec §6.2.1; `method`/functional `params` are add-in JSON-RPC values **verbatim**, with only recognized display side-channel fields merged |
| `invoke_batch` | G→B | `{batch_id,atomic,timeout_ms,recovery_clearances:[…],steps:[{invocation_id,method,params,params_digest,mutating,mutation_scope,policy:{class,decision,confirmation_id}}],batch_digest}` — raw params cannot be omitted; per-step and whole-batch RFC 8785 digests are independently verified. One top-level batch result carries `status`, `transaction_state`, zero-based `failed_step_index`, and every ordered step. `atomic:false` stops at first guarded/failed/cancelled/indeterminate step on first delivery and redelivery; `atomic:true` requires per-session `batch_atomic` and one `execute_batch` frame. |
| `result` | B→G | Invocation: `{kind:"invocation",invocation_id,status,result?,guarded_reason?,replayed,payload_omitted?,result_digest?,late_after_indeterminate?,verification_hold_id?,artifacts?,metrics}` with status in `{completed, guarded}`. `guarded_reason` is required exactly for guarded. Omission and late evidence are replay-only and digest-bound. Batch carrier follows spec §11.1. |
| `partial` | B→G | Chunk = `{kind:"chunk",invocation_id,stream_id,artifact_id?,artifact_index?,chunk_index,encoding:"base64",content_type,data}` with RFC 4648 padded bytes; progress = `{kind:"progress",invocation_id,progress:{elapsed_ms,note}}`. Artifact identifiers are required exactly for `artifact:<artifact_id>` streams; terminal descriptors carry each stream's count/size/digest. |
| `error` | B→G (invocation) or either dir (protocol) | `{invocation_id?,retryable,fault_class,outcome,verification_required,replayed?,late_after_indeterminate?,verification_hold_id?,mutation_scope?,result_digest?,message,addin_error?}` with outcome in `{known, indeterminate}` — every top-level/nested error carries explicit outcome and verification fields; indeterminate errors require hold/scope correlation |
| `cancel` | G→B | `{invocation_id,reason}` with reason in `{user_requested, client_disconnected, deadline_exceeded, gateway_shutdown}` — best effort; late real outcome remains journaled and an uncertain mutation is indeterminate |
| `doc_context_update` | B→G | `{documents:[…],active_document,active_view:{id,name,type,level?},discipline_hint?}` — per P-O1-11, sourced from cached `get_document_context` every 15 s and after register/resume |
| `manifest_check` / `manifest_info` | B→G / G→B | Check requires `{bridge_version,addin_versions,channel,highest_accepted_release_sequence}`. Info requires `{status,channel,latest_version,min_supported_version,release_sequence,…}`; signed artifact URLs/hashes remain inside O9 manifest. |
| `goodbye` | either | `{reason,retry_after_ms?,message?}` with reason in `{shutdown, update, server_draining, protocol_error, auth_revoked}` |

**Error taxonomy (`fault_class`):** `protocol`, `auth`, `policy`, `unsupported`, `parameter`,
`environment`, `revit_busy`, `revit_timeout`, `revit_api`, `addin_unreachable`, `journal_indeterminate`,
`oversize`, and `cancelled`. `environment` means a transient connection/process/host condition whose
non-committing outcome is known; it is never a label for an unknown write. After the first add-in byte may
have been sent, timeout, process loss, cancellation uncertainty, or unreachability for `mutating:true` is
promoted to non-retryable `journal_indeterminate` with `outcome:"indeterminate"` and
`verification_required:true`. Every error explicitly carries retryability and outcome.

### 4. Idempotency journal semantics

- **Store semantics:** one device-local durable SQLite-class store, implementation-neutral per RES-2. Logical
  states are `received → executing → completed|failed|guarded|cancelled|indeterminate`. Persist `received`
  and the digest before the first add-in byte, persist dispatch ownership, and persist the terminal outcome
  before sending it. A crash after possible dispatch without terminal persistence is indeterminate.
- **Key and binding:** exact canonical string `rsid + "/" + invocation_id`; bind method, mutating flag,
  `mutation_scope`, full policy/confirmation block, recovery clearance, and batch position separately. The
  idempotency key identifies one operation but never serves as the fresh-write block index.
- **Digest:** `params_digest = "sha256:" + lowercase_hex(SHA-256(UTF-8-without-BOM(RFC8785-JCS(params))))`.
  Input is the functional `params` JSON value before display/audit side-channel fields. Duplicate keys and
  non-finite values are rejected; no extra Unicode normalization occurs. Golden vectors cover property order,
  numeric form, Unicode, and escapes.
- **Batch digest:** every step contains both raw `params` and its verified `params_digest`; neither may be
  omitted. One required `batch_digest` binds batch id, atomic flag, timeout, recovery clearances, and every
  ordered step's id/method/mutating/scope/digest/full policy block through the exact RFC 8785 representation in
  spec §11. A coordination row is durable before dispatch and rejects any changed canonical params value or
  semantic field while accepting harmless equivalent JSON reserialization.
- **Redelivery:** a terminal row replays without add-in execution. A non-terminal read may execute at most
  once more. A non-terminal mutation never re-executes: return `journal_indeterminate` and install a conflict
  hold indexed by `(rsid,mutation_scope)`. Gateway and Bridge check that durable index before every mutation,
  including a fresh invocation/batch id. A correlated read or conclusive late durable terminal supplies
  evidence; only an audited evidence-digest-bound clearance deterministically opens the scope. Inconclusive
  evidence stays blocked. Same-key changes are `protocol`; replay-only omission/late fields follow spec §10.3.
- **Batch recovery:** `atomic:false` replays a terminal prefix, stops at the first terminal non-success, and
  may recover only the first non-terminal read; a non-terminal mutation becomes indeterminate. Once an
  `atomic:true` dispatch may have started, the whole batch is indeterminate unless its durable terminal batch
  outcome exists; no step retry is allowed and each affected scope receives one hold over its ordered possibly
  executed origins. Nested errors always carry their own outcome and verification requirement.
- **Retention:** keep rows at least seven days and longer than every resume/redelivery window (Phase-1
  default 14 days). A row cap MUST NOT prune non-terminal or recovery-hold rows. The journal survives Bridge
  restarts and self-updates.

### 5. Flow control & size limits (aligned with the existing 8192-fix framing constraints)

| Limit | Value | Alignment |
|---|---|---|
| In-flight window per `rsid` | **1** invoke or invoke_batch | Hard constraint "serial per session"; replaces lock dirs + preflight (P-O1-5/6). Violation ⇒ `protocol` fault. Distinct rsids and control frames are unconstrained |
| `invoke`/step params (serialized) | ≤ 4 MiB | Safely under the add-in default message cap of 16 MiB / absolute 128 MiB via `REVAGENT_MAX_MESSAGE_BYTES` (SocketService.cs:19-21, 67-76); Bridge pre-rejects locally with `oversize` before touching the add-in, mirroring the add-in's own oversize error + connection abort behavior (:281-290, 344-352) |
| `partial` chunk | ≤ 1 MiB | Per identified result/artifact stream; keeps WS frames proxy-friendly; Bridge chunks after reading the full add-in response |
| Total result per invocation | ≤ 32 MiB combined; ≤16 artifact streams | Matches the current client cap `MAX_RESPONSE_BYTES` (SocketClient.ts:4) and the add-in's re-framed accumulation (SocketService.cs:243-313); larger results are a WP2 Gateway hygiene concern, not a reason to raise the RBP carrier limit |
| Control frames / `doc_context_update` | ≤ 64 KiB / ≤ 256 KiB | Heartbeats must never queue behind data |
| Default `timeout_ms` | 120,000 | Matches today's client default (SocketClient.ts:378); Gateway-side deadline = `timeout_ms` + 10 s grace. Per-command ExternalEvent waits inside the add-in (15 s–60 s, e.g. GetSelectedElementsCommand.cs:39, ExecuteCodeCommand.cs:41) remain the inner bound |

Backpressure: with window=1 per rsid, invocation backpressure is structural; the Bridge additionally pauses
chunk emission when either binding has more than 8 MiB buffered/unaccepted outbound data. Control messages and
heartbeats remain serviceable on independent WSS/HTTP scheduling paths.

### 6. Versioning & compatibility

- `hello.min_protocol/max_protocol` (ints); Gateway selects `protocol` in `hello_ack`; no overlap ⇒ close 4426 + manifest pointer (upgrade path).
- Within a version: additive-only changes (new optional fields, new capability-gated message types); unknown fields ignored. Breaking changes bump the integer.
- Gateway supports v(N) and v(N−1) (P-O1-9). Connection capabilities such as `chunked_results`,
  `artifact_result_v1`, and `transport_streamable_http`, plus per-session grants such as `batch_atomic`, gate
  optional behavior inside a version.
- The add-in hop keeps its own independent contract (`resultContractVersion:2`, BridgeResultContract.cs:10); RBP passes it through opaquely — the two versions never couple.

### 7. Command pass-through mapping (add-in framing unchanged)

The Bridge forwards `method` + `params` verbatim over the existing length-prefixed TCP framing (4-byte BE header — write: SocketClient.ts:396-406; read: SocketService.cs:336-367, 446-452; response write :454-468), with JSON-RPC `id` = `invocation_id` (P-O1-3). The mapping is maintained by command family so additive registry growth does not make a frozen numeric count authoritative:

| Category | Commands | `mutating` (journal) | Default policy class (D12, owned by Tool Registry) | Notes |
|---|---|---|---|---|
| Context reads | `get_current_view_elements`, `get_current_view_info`, `get_selected_elements`, `get_ui_state`, `list_open_views` | false | `auto` | Ordinary tools only; they are not the standing context watcher (RES-3) |
| Inspection/query | `find_elements`, `inspect_levels`, `inspect_sheet_text`, `inspect_schedules`, `count_annotations` | false | `auto` | Wide parameterized shape already matches §5.3 |
| Spatial | `extract_spatial_snapshot`, `get_spatial_change_state` | false | `auto` | Paged multi-invoke sequences; `suppressTaskStatusWindow` side-channel honored (SocketService.cs:544-547) |
| UI navigation (no model write) | `activate_view`, `close_view`, `clear_selection`, `focus_elements`, `open_existing_plan_for_element_level` | false (re-execution harmless) | `auto` | Idempotent by nature; invocation redelivery rule 3 applies |
| Model writes | `create_3d_view_for_elements` (Transaction, Create3DViewForElementsEventHandler.cs:319), `section_box_elements` (SectionBoxElementsEventHandler.cs:270), `delete_review_view` (DeleteReviewViewEventHandler.cs:213) | **true** | `auto`/`confirm` per registry | Invocation redelivery rule 4 (never blind re-execute) |
| Dynamic code | `send_code_to_revit` | **true** always | `confirm` (raw) / `auto` behind the safe wrapper's regex guards (send_code_to_revit_safe_guards.ts:1-27, send_code_to_revit_safe.ts:33-52) | Auto/manual transaction detection stays add-in-side (ExecuteCodeEventHandler.cs:56, 137, 146); `execute_batch` rejects an inner `TransactionGroup` in step code |
| Pseudo | `mcp_status` (served without registry dispatch, SocketService.cs:522-526) | false | n/a | Absorbed into heartbeat `revit_status`; stays invocable for diagnostics only |
| Pre-pilot adaptations | `get_document_context`, `execute_batch` | false / per-step | internal | Required by RES-3/4/5; their presence and contract versions produce per-session `doc_context_cached_v1`/`batch_atomic` grants |

The Bridge does **not** port: the legacy-JSON fallback (P-O1-10), the loose correlation that broadcasts unmatched errors to all pending callbacks (SocketClient.ts:223-238 — with window=1 and exact id matching this hole closes), or the busy preflight (P-O1-6).

### 8. Minimum executable conformance list (M1 freeze gate and pilot prerequisite)

The canonical list is the 40-case suite in `docs/specs/O1-bridge-gateway-protocol.md` §21. The M1 harness runs
Gateway stub + Bridge simulator + exact loopback fixture and emits machine-readable results. No case receives
a green mark in this plan before evidence exists. Required groups are:

1. transport/auth/version/session lifecycle, including zero-based jitter, `N`/`N-1`, unregistration, and
   WSS versus exact HTTP/SSE proxy interoperability;
2. safe sequence/ack/retransmission/resume across restart, maximum JSON-safe sequence, and window=1;
3. journal durability, RFC 8785 invocation/step/batch digests, replay-only omission/late evidence,
   `(rsid,mutation_scope)` conflict holds, fresh-id bypass rejection, correlated verification, and every
   deterministic clearance transition;
4. first-delivery plus mixed-redelivery batch carriers, raw-step presence, nested full-error fields, guarded
   stop, atomic rejection, commit, rollback, per-scope holds, and indeterminate recovery;
5. every payload/conditional-envelope schema, stream-identified chunk/Base64/backpressure/oversize,
   multi-file mapping, cancellation, and complete top-level/nested error mapping;
6. loopback-only discovery, per-session add-in capability/version proof, cached document context, seat/actor
   spoof rejection, the GAP-7 RBP multi-file output carrier, and exact 4-byte add-in framing. WP2/WP9 own
   north upload, artifact resources, and client display evidence.

Pilot entry additionally requires the adapted real add-in smoke: each method family, one confirm-class write,
forced reconnect, cached context, loopback rejection, one atomic batch, and retained model/journal evidence.

---

## (c) Work Breakdown

Estimates: one senior dev + AI coding assistant, in dev-days.

| ID | Task | Depends on | Acceptance criteria | Est. |
|---|---|---|---|---|
| O1-T1 | **Freeze-candidate spec + full JSON Schemas.** Maintain `docs/specs/O1-bridge-gateway-protocol.md`; author envelope and every payload/conditional branch under `packages/protocol/schemas/rbp/v1`; generate types into `packages/protocol/src/generated`. | — | Canonical `1.0` candidate semantic review closed; schema positives/negatives cover every applicable field/conditional in the 40-case corpus; generate then clean-diff gate passes. This is semantic/schema evidence, not an executable-case or M1 pass. | 3 |
| O1-T2 | **Shared protocol library** `packages/protocol` (TS, ESM, strict): validation, canonical invocation/step/batch digest helpers, seq/ack bookkeeping, mutation-scope conflict/clearance logic, and pure connection/invocation/journal FSMs with zero transport I/O. | O1-T1 | Unit/property tests green; Gateway stub and simulator consume one implementation; production .NET Bridge uses the same vectors rather than importing TS. | 3 |
| O1-T3 | **Add-in loopback fixture:** exact 4-byte BE framing, limits, `mcp_status`/`get_document_context` version-capability shapes, `execute_batch`, guarded/full nested-failure outcomes, multi-file output artifacts, busy/delay/stall, and disconnect/crash/late-outcome windows. | O1-T1 | Framing and payload vectors pass on Linux; execution counters expose every exactly-once assertion. | 2 |
| O1-T4 | **Implementation-independent Bridge simulator:** both RBP bindings, durable journal and `(rsid,mutation_scope)` hold semantics through a test adapter, correlated verification/late evidence/clearance, multi-stream chunk/artifact path, bounded loopback discovery, heartbeat/backoff/resume, and fault injection. It is conformance code, not the production Bridge technology decision. | O1-T2, O1-T3 | N sessions register with exact capabilities; crash/restart preserves holds and evidence; fresh ids cannot bypass; mutation executes at most once; no temp registry or filesystem lock dependency. | 4 |
| O1-T5 | **Gateway stub:** WSS plus exact HTTP/SSE lifecycle, static test authentication, version/capability/session tables, window=1 dispatcher, resume/retransmit, RBP-carrier-only artifact sink, and fault/proxy controls. It does not implement WP2 `artifact_ref` or north-resource behavior. | O1-T2 | Both bindings run the same semantic corpus; opening-error, buffer, EOF, duplicate, gap, restart, and scope faults are injectable. | 3 |
| O1-T6 | **40-case conformance suite + CI:** execute spec §21 against T3/T4/T5 and retain the protected PR check rollup. The nightly reconnect/proxy-churn soak and retained aggregate continue in the separate tag-closure lane. | O1-T3, O1-T4, O1-T5 | One complete current-candidate suite is green for all 40 cases and both bindings; suite <10 min; no fd/memory/journal-state leak. The deferred tag closure separately requires three retained runs and the real one-hour soak. | 5 |
| O1-T7 | **Adapted real-add-in pilot interop smoke** on an approved Windows/Revit seat: all method families, cached context/version grants, loopback rejection, confirm write, bridge kill/resume, artifact output, and atomic commit/rollback. | O1-T6 + WP3 add-in adaptation | Post-freeze pilot gate: RBP/add-in versions retained; model, audit, and journal agree; indeterminate write is verified; atomic batch and loopback-only requirements pass. Any mismatch follows version/R-F rules. | 2 |
| O1-T8 | **Ratification & semantic freeze:** fold harness findings into spec/schemas, publish the protocol constant, produce `docs/plan/M1_O1_FREEZE_EVIDENCE.md`, and protected-merge the green candidate. Create `rbp/v1.0.0` only after the separate tag-closure evidence passes. | O1-T6 | The protected tree-equal squash merge freezes canonical `1.0` and closes M1. The same protected candidate may be tagged only after the retained three-run aggregate, real one-hour soak, WSS/Streamable HTTP/SSE proxy-interoperability evidence, and tag-identity checks pass. That lane is non-blocking for M2/M3. Later semantic change follows P-O1-9; real add-in and WP9 hands-on proof remain pilot gates. | 1 |

**Package total: 23 dev-days.** M1 freeze path: T1 → T2/T3 → T4/T5 → one full current-candidate T6 suite → T8 protected merge. The deferred three-run/soak/proxy-interoperability tag lane may then run in parallel with M2/M3. Pilot validation separately adds T7 plus WP9 hands-on evidence.

### Evidence/status discipline

- A spec diff, complete schemas, generated-type clean diff, and golden serialization vectors prove only the
  semantic/schema tier. They MUST NOT mark O1-T3, T4, T5, T6, T7, or the full M1 milestone passed.
- O1-T3/T4/T5 are running fixture/simulator/stub deliverables; O1-T6 is the
  complete green 40-case PR check rollup. T8 sets `1.0 / Frozen` only after that exact green candidate reaches protected `main`.
  Tag creation remains a separate non-blocking closure and does not hold M2/M3.
- O1-T7 is a distinct post-freeze Windows/real-Revit pilot-entry smoke. WP9 client evidence is distinct again;
  neither may be inferred from the Linux harness or schema/golden demo.
- Evidence requirements are limited by RES-28 and R-H. The implementing assistant
  cannot add repetitions, soak duration, or blocking status beyond the
  authoritative gate without explicit R-G operator authorization. Required
  current-head CI remains part of the authoritative gate.
- Any implementation-driven departure from the required shape, hold transition, digest, error carrier, or
  artifact stream requires a dated R-F record before the plan/spec changes. A relaxed test or undocumented
  tolerance is a red gate, not acceptance.

---

## (d) Test Strategy

- **Golden vectors (unit):** byte-exact corpora for (i) RBP envelopes vs JSON Schemas, (ii) add-in framing — header encoding, split reads, coalesced messages, oversize — derived from SocketService.cs:243-313/336-367/446-468 and SocketClient.ts:185-211. These vectors are the contract artifact that survives future ports (e.g. a Rust/.NET bridge).
- **Property-based tests** (fast-check) on the pure FSMs from O1-T2: arbitrary interleavings of {deliver,
  duplicate, fresh-id mutation, drop, reorder-across-reconnect, crash, late outcome, verification, clearance}
  must never cross an active session/scope hold or double-execute a mutation, and valid evidence must be the
  only path through the deterministic clear transition.
- **Conformance matrix (integration):** §8 list, three-process harness (fixture + simulator + stub) on Linux CI; every test asserts both wire behavior and journal/DB ground truth (execution counts asserted at the fixture, not inferred).
- **Fault injection:** stub control API + OS-level actions (SIGKILL the simulator, `socket.destroy()` for RST, half-open by suspending the stub) — specifically covering the crash window between add-in completion and journal outcome commit.
- **Soak:** nightly 1 h reconnect churn in CI is retained tag-closure evidence and is non-blocking for M1/M2/M3; a 24 h soak on office hardware through the real Cloudflare-style tunnel remains a pre-pilot exit criterion (validates heartbeat intervals vs real proxy idle timeouts).
- **Real interop:** O1-T7 on Windows with live Revit — the only test tier that exercises ExternalEvent timing truths (per-command 15–60 s waits, UI-thread serialization) that fixtures can't emulate.
- **Negative security:** revoked token mid-connection, another rsid's `resume_token`, cross-rsid invoke,
  params/step/batch-digest mismatch, omitted batch params/step, fresh-id hold bypass, forged evidence digest,
  foreign-scope clearance, and artifact stream/id/index collision all fail closed before add-in bytes.
- **CI placement:** all tiers except O1-T7 run on standard Linux runners inside ci.yml; nothing in this package touches the `revagent-cd` Windows runner or the signed CD pipeline (those are exercised by the Bridge-product and O9 packages).

---

## (e) Risks Specific to This Package

1. **RevitMCPSDK is external and version-locked** (`RevitMCPSDK:$(RevitVersion).*`, revAgentPlugin.csproj:46): any temptation to "improve" the add-in hop (e.g., JSON-RPC envelope tweaks) drags in an SDK we don't own. Mitigation: P-O1-3/P-O1-10 keep framing byte-compatible; RES-5's `execute_batch`/`get_document_context` additions stay isolated and capability-versioned.
2. **Indeterminate-write friction in the pilot:** scope holds convert some flaky-link retries into "verify then
   decide" round-trips; over-triggering will read as flakiness to pilot users. Mitigation: fsync ordering
   minimizes the window; exact scope avoids unnecessarily blocking unrelated documents; late durable evidence
   is reusable; every active/evidence/resolution/clear transition is retained and counted as a pilot metric.
3. **Corporate proxy/TLS-inspection behavior vs long-lived WSS/SSE:** idle resets, buffering, or WS-hostile middleboxes can break either binding differently. Mitigation: both bindings are Phase-1 requirements; exact opening semantics, 15 s heartbeat, proxy golden tests, forced EOF/resume, and the 24 h real-tunnel soak are go/no-go gates.
4. **Current add-in wildcard listener** (`TcpListener(IPAddress.Any, port)`, SocketService.cs:157) bypasses Gateway policy/audit from the LAN. Mitigation: RES-5 requires loopback-only binding before pilot; wildcard, hostname-resolved remote, LAN, and override targets fail conformance with no production opt-out.
5. **Concurrent non-Bridge clients during migration:** singleton command instances race on handler parameter state under multiple clients (defended in GetSelectedElementsCommand.cs:16/28; undefended in ExecuteCodeCommand) and the old runtime's tmpdir locks don't see the Bridge. Window=1 protects only Bridge traffic. Mitigation: cutover runbook (D11 step 3) removes old runtimes before the Bridge goes live per machine; pilot machine runs Bridge-only.
6. **Known add-in wait race** — `ExecuteCodeEventHandler.WaitForCompletion` resets the event before waiting (ExecuteCodeEventHandler.cs:43-47), which can drop an already-signaled completion and will surface as spurious `revit_timeout` under the conformance timing tests. Mitigation: documented as an add-in adaptation fix; conformance test 11 tolerances set so the protocol layer isn't blamed for it.
7. **Instance discovery ambiguity on multi-Revit machines:** the port-scan + `mcp_status` probe (P-O1-12) can misattribute rsids if a non-RevAgent service squats 8080-8085. Mitigation: registration requires a valid `mcp_status` snapshot shape + add-in version echo; mismatches are logged and skipped.
8. **Scope creep toward O3/O9:** enrollment backends and update plumbing are adjacent and tempting. Mitigation: hard non-goals list in §(a); the stub's static token table and manifest message shapes are the contractual maximum this package builds.
9. **Artifact transport becoming arbitrary file access or a north-MCP shadow contract:** a generic
   `file_fetch` would turn the Bridge into a workstation file proxy, while O1-owned `artifact_ref` semantics
   would conflict with WP2/WP9. Mitigation: P-O1-13 rejects file fetch and limits O1 to the declared,
   spool-confined, multi-file Bridge→Gateway carrier; WP2 owns Gateway ingress/resources and WP9 owns actual
   Codex Desktop file/image conformance.

**Key files for the implementing engineer:** /home/user/revAgent/docs/TARGET_ARCHITECTURE.md (§5.4, 5.7, 8, 10/O1); /home/user/revAgent/installer/runtime-mcp-server/src/utils/SocketClient.ts; /home/user/revAgent/installer/runtime-mcp-server/src/utils/ConnectionManager.ts; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/SocketService.cs; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/BridgeResultContract.cs; /home/user/revAgent/src/revit-plugin/revAgentPlugin/Core/McpTaskStatusService.cs; /home/user/revAgent/src/revit-plugin/revAgentCommandSet/command.json; /home/user/revAgent/installer/runtime-mcp-server/schemas/ (schema-versioning pattern to copy).
