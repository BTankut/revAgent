# O1 Bridge-to-Gateway Protocol Specification

| Field | Value |
|---|---|
| Protocol name | RBP/1 (RevAgent Bridge Protocol, version 1) |
| Document version | 0.9 |
| Status | Draft, in review |
| Milestone | M0 draft; M1 freezes v1.0 after review and conformance feedback |
| Updated | 2026-07-22 |
| Owner | WP1 / O1 |

RBP/1 is the internal RPC protocol between the RevAgent Gateway and the thin desktop bridge. It is not MCP. MCP exists only at the Gateway north boundary. The bridge-to-add-in hop remains the existing length-prefixed JSON-RPC TCP protocol.

Normative precedence is:

1. `docs/TARGET_ARCHITECTURE.md`
2. `docs/implementation-plan/00-INDEX.md`
3. This specification
4. `docs/implementation-plan/01-protocol-O1.md`

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative requirements. Any implementation finding that invalidates a RES-* decision must use the R-F amendment process; implementations must not silently diverge.

## 1. INDEX amendment compliance

This v0.9 draft incorporates the coordinator resolutions that override the original package plan.

| Resolution | Canonical v0.9 rule |
|---|---|
| RES-2 | The bridge is a .NET 8 self-contained Windows service. RBP journal semantics are implementation-neutral and require a durable SQLite-class store; this specification does not depend on Node or `better-sqlite3`. |
| RES-3 | Document context is sourced from the add-in's cached `get_document_context` command and polled by the bridge every 15 seconds. `get_current_view_info` and `list_open_views` are not used as the standing context poll. |
| RES-4 | The additive add-in command is named `execute_batch`. `batch_execute` is invalid. Batch behavior is capability-gated by `batch_atomic`. |
| RES-5 | The pilot runs the same adapted add-in stack intended for cutover, including loopback binding, `execute_batch`, `get_document_context`, and the concurrency fixes. An unchanged-add-in pilot is not sufficient. |
| RES-10 | No `mcp_status` call occurs as a preflight on the invocation hot path. The bridge consults it for heartbeat state and, when an invocation fails, to enrich a structured busy diagnosis. |
| RES-16 | The Gateway dispatcher is the authoritative serial-per-session enforcement point. The bridge queue and add-in defenses are defense-in-depth. |
| RES-17 | Instance discovery never reads `%TMP%\revAgent-instances.json`. It uses an explicit environment override or a bounded port scan with an `mcp_status` shape probe. |
| RES-21 | The canonical idempotency key is the exact composite string `rsid + "/" + invocation_id`. Journal and audit storage reference this definition. |
| RES-25 | Phase 1 uses WSS as the primary RBP binding and provides a capability-gated Streamable HTTP/SSE fallback with identical message semantics. |

## 2. Scope and boundaries

### 2.1 In scope

- Device-authenticated outbound bridge connection and protocol negotiation
- Revit-session registration, unregistration, resume, and liveness
- Invocation, batch, result, partial-result, progress, error, and cancellation messages
- Per-session sequencing, acknowledgement, retransmission, and backpressure
- Durable idempotency-journal semantics and redelivery behavior
- Cached document-context updates
- Bridge/update manifest message shapes at the O9 boundary
- Version and capability negotiation
- Structured error taxonomy and conformance requirements

### 2.2 Out of scope

- The Gateway north MCP protocol and OAuth interaction with designer clients
- The GAP-2 client confirmation UX; RBP carries the resulting policy/confirmation correlation but does not let a bridge approve an action
- Enrollment-code issuance, OIDC login, licensing database, or seat administration
- Gateway orchestration, tool discovery, result-ref storage, or LLM provider details
- Bridge installer, service hosting, tray UX, and update-apply mechanics
- Add-in TCP framing changes or RevitMCPSDK changes
- APS execution
- The final GAP-7 file-ingress mechanism; it is selected with DP-10/WP9 and must be added as a capability-gated extension before v1.0 if required for pilot

### 2.3 Protocol boundaries

| Hop | Protocol |
|---|---|
| External MCP client to Gateway | MCP over Streamable HTTP + OAuth |
| Gateway to bridge | RBP/1 over the selected outbound transport |
| Bridge to add-in | Existing 4-byte big-endian length-prefixed JSON-RPC TCP framing |
| Gateway to LLM/APS | Outside RBP/1 |

Model files do not traverse RBP/1. Tool parameters, bounded results, progress, document metadata, and update metadata may traverse it.

## 3. Identifiers and authority

| Identifier | Minted by | Meaning and lifetime |
|---|---|---|
| `device_id` | Gateway enrollment service | Stable enrolled workstation identity |
| `connection_id` | Gateway | One authenticated transport connection; never used for idempotency |
| `rsid` | Gateway | One registered local Revit process/session; survives reconnect within the resume lifetime |
| `invocation_id` | Gateway dispatcher | UUIDv7 for one logical invocation; reused only for retransmission/redelivery of that invocation |
| `idempotency_key` | Derived | Exact string `rsid + "/" + invocation_id` |
| `batch_id` | Gateway dispatcher | UUIDv7 correlating an ordered batch and its step invocations |
| `seq` | Sender | Monotonic JSON-safe integer from 1 through 9,007,199,254,740,991 (`2^53-1`) per `rsid`, per direction, continuing across reconnects |
| `resume_token` | Gateway | Opaque secret bound to device, `rsid`, and expiry; not an actor credential |
| `confirmation_id` | Gateway policy layer | Correlates an approved preview/action; never minted or approved by the bridge |

The OIDC user is the authoritative human actor. A Windows username supplied by session registration is an operational hint only and MUST NOT replace the authenticated actor in audit records.

`seq` is deliberately narrower than an unsigned 64-bit counter because JSON implementations commonly use
IEEE-754 numbers. Fractions, exponent forms that do not decode to the exact integer, negative values, and
values above `2^53-1` are invalid. A sender MUST NOT wrap. Before exhaustion, it MUST drain all acknowledged
data and register a new `rsid`; receivers MUST reject an unsafe value as a `protocol` fault.

## 4. Transport profile and authentication

### 4.1 Phase-1 profile

DP-2 confirms one persistent outbound WSS connection per bridge process as the primary Phase-1 binding:

```text
wss://gateway.revagent.app/bridge/v1
```

The bridge MUST validate the server certificate and connect to the configured DNS name, never an IP address. The HTTP upgrade carries:

```text
Authorization: Bearer <device_token>
X-RBP-Versions: 1
```

Expected refusal responses are:

- `401` for missing, invalid, expired, or revoked device credentials
- `403` for device, tenant, or license refusal
- `426` with `{min_protocol,max_protocol,manifest_url}` when no protocol version overlaps

A Streamable HTTP/SSE fallback is REQUIRED behind the `transport_streamable_http` capability. RBP
envelopes, ordering, acknowledgement, resume, journal, and error semantics are identical on both bindings.
The exact HTTP request/stream lifecycle is a v1.0 freeze blocker and MUST NOT be improvised before its golden
vectors and proxy/interoperability evidence are recorded. The fallback does not switch an active WSS
connection in place; it reconnects and resumes through the negotiated fallback binding.

### 4.2 Connection opening

After transport authentication:

1. Bridge sends `hello` as the first protocol message.
2. Gateway returns `hello_ack` selecting exactly one protocol version and a capability intersection.
3. Any non-`hello` first message closes the connection with protocol error `4400`.
4. No version overlap closes with `4426` and an update-manifest pointer.
5. Authentication loss closes with `4401`; authorization/seat refusal closes with `4403`.

### 4.3 Reconnect backoff

Every unsuccessful connection attempt or connection that leaves `steady` before 120 continuous seconds
increments attempt index `n`, starting at zero. Before the next automatic attempt, the bridge waits:

```text
limit_ms = min(60000, 1000 * 2^n)
delay_ms = uniform_random_integer(0, limit_ms)
```

This is exponential backoff with full jitter: 1 second initial base, factor 2, and 60 second cap. A TCP/TLS/WSS
handshake alone MUST NOT reset the counter. It resets only after 120 continuous seconds in `steady`.
Authentication or authorization refusal (`401`, `403`, `4401`, `4403`) MUST pause automatic retries until
credentials, enrollment, authorization, or operator state changes. A `goodbye` reason may further suppress or
delay reconnect as specified in Section 6.3.

## 5. Envelope

One RBP message is one JSON object. Under WSS, one object occupies one text frame.

```json
{
  "v": 1,
  "type": "invoke",
  "id": "0197a3c2-0000-7000-8000-000000000001",
  "rsid": "rs_7f3a",
  "seq": 412,
  "ack": 409,
  "ts": "2026-07-22T12:00:00.000Z",
  "payload": {}
}
```

Rules:

- `v` is the selected protocol integer and MUST remain constant for the connection.
- `id` is a sender-minted UUIDv7 envelope identifier. It is not the idempotency key.
- `rsid` and `seq` are REQUIRED on session data messages and absent on connection control messages. `ack` is an optional cumulative acknowledgement piggyback.
- `ts` is diagnostic only. Ordering authority is `seq`; clock skew is tolerated.
- Unknown fields MUST be ignored within the same protocol version.
- Unknown message types MUST return `unsupported` unless a negotiated capability declares them.
- JSON text is UTF-8. Non-finite numbers and duplicate object keys are invalid.

### 5.1 Control and data messages

Control messages are not retransmitted and do not consume a session sequence:

```text
hello, hello_ack, session_register, session_registered,
session_resume, resume_ack, session_unregister,
heartbeat, heartbeat_ack, manifest_check, manifest_info, goodbye
```

Session-scoped data messages are sequenced, acknowledged, and retransmitted until cumulatively acknowledged:

```text
invoke, invoke_batch, result, partial, error, cancel, doc_context_update
```

A connection-level protocol/auth error without an `rsid` is an unsequenced control response and normally closes the connection. An invocation error is session-scoped data and follows the acknowledgement/retransmission rules.

### 5.2 Sequence, acknowledgement, and retransmission

- The first data message in each direction for an `rsid` has `seq:1`. `ack:0` and `last_rx_seq:0` mean that
  no data message has yet been durably accepted in the opposite direction.
- A receiver advances its cumulative acknowledgement only after it has durably accepted every data message
  through that sequence. It MAY piggyback the value in `ack`; `heartbeat`, `heartbeat_ack`, and resume
  messages carry explicit per-session acknowledgement state.
- A sender MUST retain every unacknowledged data envelope and retransmit it after resume in ascending `seq`
  order. A retransmission preserves `id`, `v`, `type`, `rsid`, `seq`, and the complete `payload`; only `ack`
  and diagnostic `ts` MAY be refreshed.
- A duplicate `seq` with the same retained envelope identity is acknowledged but MUST NOT be dispatched
  again. A duplicate with different immutable fields is a terminal `protocol` fault.
- A forward gap MUST NOT be guessed across. The receiver closes or enters resume and requests retransmission
  from the last contiguous sequence. Out-of-order data is never exposed to invocation logic.
- Cumulative acknowledgement removes only transport retransmission state. It does not delete an invocation
  journal row and is not evidence that a Revit mutation committed.

## 6. Connection and session lifecycle

The bridge connection state machine is:

```text
idle -> connecting -> authenticating -> hello_exchange -> steady
steady <-> degraded
steady|degraded -> resuming|re_enrolling|backoff
```

### 6.1 Registration

The bridge sends one `session_register` for each discovered Revit process:

```json
{
  "type": "session_register",
  "payload": {
    "local_session_key": "port:8080:pid:1234",
    "user_hint": {"name": "BT"},
    "machine": {"hostname": "WS01", "fingerprint": "sha256:..."},
    "revit": {"version": "2022", "build": "...", "pid": 1234},
    "addin_version": "2026.07.22.0",
    "bridge_version": "0.1.0",
    "documents": [
      {
        "document_id": "doc_session_stable_id",
        "title": "Project A",
        "path_digest": "sha256:lowercase-hex-or-null",
        "is_workshared": true,
        "is_active": true
      }
    ],
    "port": 8080
  }
}
```

The Gateway validates the device/session association and returns:

```json
{
  "type": "session_registered",
  "payload": {
    "rsid": "rs_7f3a",
    "resume_token": "opaque",
    "resume_expires_at": "2026-07-23T12:00:00.000Z",
    "principal": {"tenant_id": "tenant_uuid", "user_id": "user_uuid"},
    "seat": {"granted": true, "seat_id": "seat_uuid"}
  }
}
```

Each `documents[]` object requires `document_id`, `title`, `path_digest`, `is_workshared`, and `is_active`.
`path_digest` is either `null` or `sha256:` plus 64 lowercase hexadecimal characters; a raw model path MUST
NOT be sent. `document_id` is stable only within the registered add-in session. At most one document may have
`is_active:true`.

`local_session_key` and `user_hint` are diagnostic only and MUST NOT become authority or cross-device
identifiers. The Gateway derives `tenant_id`, `user_id`, and `seat_id` from the authenticated device enrollment
and seat assignment; a bridge cannot claim or choose them in `session_register`. Missing assignment or a
payload/enrollment mismatch is `auth`, closes/refuses with `4403`, and is audited as a seat-identity spoof
attempt. The north-side OIDC actor for an invocation is retained separately from this bridge principal.

Revit exit sends `session_unregister`; pending invocations end with `addin_unreachable` only when non-execution
is known. A possibly dispatched mutation follows the indeterminate rules below.

### 6.2 Resume

On reconnect, the bridge sends one control message per resumable session:

```json
{
  "type": "session_resume",
  "payload": {
    "rsid": "rs_7f3a",
    "resume_token": "opaque",
    "last_rx_seq": 409
  }
}
```

The Gateway returns:

```json
{
  "type": "resume_ack",
  "payload": {
    "rsid": "rs_7f3a",
    "last_rx_seq": 412,
    "resume_expires_at": "2026-07-23T12:00:00.000Z"
  }
}
```

`last_rx_seq` is the largest contiguous data sequence durably accepted from the other peer. Both peers
retransmit unacknowledged data messages in ascending sequence order under Section 5.2.

- Pending Gateway invocations are held for 10 minutes after disconnect.
- An `rsid` remains resumable for 24 hours unless explicitly unregistered or revoked.
- Resume state is durable Gateway state; a Gateway process restart MUST NOT erase it.
- Redelivered invokes always pass through the bridge journal rules in Section 12.

After the 10-minute pending window, outcome handling depends on mutation risk:

- A non-mutating invocation whose durable terminal outcome is unavailable MAY end as `environment` with
  `retryable:true`, provided no concurrent execution remains possible.
- A mutating invocation whose dispatch or commit cannot be disproved MUST end as `journal_indeterminate`
  with `retryable:false`, `outcome:"indeterminate"`, and `verification_required:true`.
- The Gateway MUST persist a recovery hold keyed by `rsid + "/" + invocation_id` and MUST NOT mint or
  dispatch a replacement mutation until an explicit read-only verification has executed and been audited.
  If the verification cannot prove the safe next action, operator intervention is REQUIRED.

Changing `invocation_id` MUST NOT be used to bypass this hold. A transport timeout, process exit, or
`addin_unreachable` signal cannot downgrade an unknown mutating outcome into a retryable environment fault.

### 6.3 Graceful close

`goodbye` is a connection-control message with this payload:

```json
{
  "reason": "server_draining",
  "retry_after_ms": 30000,
  "message": "bounded operator-safe detail"
}
```

`reason` is the closed v1 enum `shutdown`, `update`, `server_draining`, `protocol_error`, or `auth_revoked`.
`retry_after_ms` is optional and valid only for `update` or `server_draining`. `shutdown` suppresses automatic
reconnect until the local service starts again; `auth_revoked` suppresses it until credential/enrollment state
changes; `protocol_error` follows normal backoff after the offending state is corrected. `goodbye` does not
acknowledge data or erase resume/journal state.

## 7. Negotiation messages

### 7.1 `hello`

Required payload:

```json
{
  "min_protocol": 1,
  "max_protocol": 1,
  "capabilities": [
    "journal_v1",
    "chunked_results",
    "doc_context_cached_v1"
  ],
  "bridge_version": "0.1.0",
  "device_id": "device_uuid",
  "machine": {"hostname": "WS01", "os": "Windows 11"},
  "addin_versions": ["2026.07.22.0"]
}
```

`batch_atomic` is advertised only when the discovered add-in supports `execute_batch`. `transport_streamable_http` describes a bridge implementation capability; it does not switch the active connection in place.

### 7.2 `hello_ack`

Required payload:

```json
{
  "protocol": 1,
  "connection_id": "conn_uuid",
  "granted_capabilities": ["journal_v1", "chunked_results"],
  "heartbeat_interval_ms": 15000,
  "limits": {
    "max_params_bytes": 4194304,
    "max_result_bytes": 33554432,
    "max_partial_bytes": 1048576
  },
  "manifest": {
    "latest_bridge_version": "0.1.0",
    "manifest_url": "/bridge/update/manifest"
  }
}
```

The bridge MUST apply the negotiated limits even if its local limits are higher.

### 7.3 Compatibility window and within-version changes

For every deployed protocol generation `N`, the Gateway MUST accept and correctly serve RBP `N` and
`N-1` concurrently; RBP/1 is the bootstrap exception until RBP/2 exists. `hello_ack` selects the highest
mutually supported integer. One Gateway deployment MUST NOT force the whole fleet against a `4426` wall
during a staged Bridge rollout.

Within one protocol integer, changes are additive only: peers MAY add optional fields, behavior with a
backward-compatible default, or messages gated by a negotiated capability. Adding a required field, removing
or renaming a field, changing a type/unit/meaning, or adding a closed-enum value that an older peer would reject
requires a new protocol integer. Unknown optional fields remain ignorable under Section 5. The `/bridge/v1`
path names the Phase-1 endpoint profile rather than bypassing negotiation; it remains routable for the complete
`N`/`N-1` support window.

## 8. Local Revit discovery

Discovery is bridge-local and bounded:

1. If an explicit configured port/target override exists, probe it first.
2. Otherwise scan TCP ports 8080 through 8085.
3. Accept a candidate only when its `mcp_status` response matches the expected RevAgent shape and identifies a supported add-in/result contract.
4. Register each accepted Revit process as a distinct session.

The bridge MUST NOT read `%TMP%\revAgent-instances.json` or any legacy alias of that file. No production writer exists, so it cannot be authoritative. A future discovery extension requires a negotiated capability and an R-F-reviewed spec change.

Every discovery probe and add-in connection MUST target only an IP loopback address (`127.0.0.0/8` or
`::1`). The bridge MUST NOT connect to a LAN, wildcard, hostname-resolved non-loopback, or remote target even
when supplied through an override. A non-loopback candidate is rejected and audited before any JSON-RPC byte
is sent. The adapted add-in MUST bind its listener to loopback only; a wildcard listener fails pilot
conformance.

## 9. Heartbeat and liveness

The bridge sends one connection-scoped `heartbeat` every 15 seconds. It includes all registered sessions:

```json
{
  "type": "heartbeat",
  "payload": {
    "bridge_version": "0.1.0",
    "acks": [
      {"rsid": "rs_7f3a", "seq": 42}
    ],
    "sessions": [
      {
        "rsid": "rs_7f3a",
        "port": 8080,
        "revit_status": {
          "active_task": null,
          "addin_reachable": true
        }
      }
    ]
  }
}
```

Liveness thresholds are canonical across Gateway and admin UI:

- `steady`: heartbeat silence less than 35 seconds
- `degraded`: silence from 35 seconds until less than 65 seconds
- `disconnected`: silence of 65 seconds or more

The Gateway replies:

```json
{
  "type": "heartbeat_ack",
  "payload": {
    "server_time": "2026-07-22T12:00:15.000Z",
    "acks": [
      {"rsid": "rs_7f3a", "seq": 30}
    ],
    "update_available": {
      "channel": "stable",
      "manifest_url": "/bridge/update/manifest"
    }
  }
}
```

`acks` and `sessions` are REQUIRED. Each heartbeat acknowledgement is the largest contiguous
Gateway-to-bridge data sequence durably accepted for that `rsid`; zero means none. This supplies reverse
direction acknowledgement even when the bridge has no data message to send.

`server_time` and `acks` are REQUIRED; `update_available` is optional. Each `acks[].seq` is the largest
contiguous bridge-to-Gateway data sequence durably accepted for that `rsid`, using zero when none exists.
This acknowledgement participates in Section 5.2 but does not acknowledge the reverse direction. If the
bridge receives no `heartbeat_ack` for 10 seconds after a heartbeat, it closes and reconnects using Section
4.3.

The bridge MAY poll local `mcp_status` to populate the heartbeat snapshot. It MUST NOT issue `mcp_status` before every invocation. After a failed or timed-out invocation, it MAY consult `mcp_status` to distinguish an active Revit task from an unreachable add-in and enrich the resulting structured fault.

## 10. Invocation and authoritative serialization

### 10.1 Gateway rule

The Gateway dispatcher MUST maintain an in-flight window of exactly one `invoke` or `invoke_batch` per `rsid`. Distinct `rsid` values may execute concurrently. The bridge maintains a per-session queue and the add-in retains intake defenses, but those are not substitutes for Gateway enforcement.

A second Gateway data-plane invocation for the same `rsid` before the first is terminal is a protocol defect. The bridge MUST reject it without sending bytes to the add-in and return a terminal `protocol` error.

### 10.2 `invoke`

```json
{
  "type": "invoke",
  "rsid": "rs_7f3a",
  "seq": 17,
  "payload": {
    "invocation_id": "0197a3c2-0000-7000-8000-000000000010",
    "method": "inspect_schedules",
    "params": {},
    "timeout_ms": 120000,
    "mutating": false,
    "policy": {
      "class": "auto",
      "decision": "auto",
      "confirmation_id": null
    },
    "display": {
      "task_name": "Inspect schedules",
      "logical_tool_name": "core.schedule.inspect",
      "parent_task_id": null
    }
  }
}
```

Rules:

- The Gateway mints `invocation_id`; the bridge sets the add-in JSON-RPC `id` to the same value.
- `method` and functional `params` are forwarded verbatim except for server-authored display/audit side-channel fields.
- `mutating`, policy class, and policy decision come from the Gateway registry/dispatcher, never the model or client arguments.
- `confirm` requires `decision:"confirmed"` plus `confirmation_id`; `gated` requires `decision:"gated_approved"` plus `confirmation_id`. Structurally invalid policy state is rejected before add-in dispatch.
- The bridge journals the invocation before writing the first add-in byte.

### 10.3 Result

```json
{
  "type": "result",
  "rsid": "rs_7f3a",
  "seq": 18,
  "payload": {
    "kind": "invocation",
    "invocation_id": "0197a3c2-0000-7000-8000-000000000010",
    "status": "completed",
    "result": {},
    "replayed": false,
    "metrics": {
      "execute_ms": 425,
      "request_bytes": 512,
      "response_bytes": 4096,
      "framing": "length-prefixed"
    }
  }
}
```

For `kind:"invocation"`, `status` is `completed` or `guarded`. A guarded add-in result remains a result, not a transport failure. Add-in `resultContractVersion` is passed through without coupling it to RBP version.

## 11. Batch invocation

The RBP message type is `invoke_batch`. The additive add-in command used for one-frame atomic execution is exactly `execute_batch`.

```json
{
  "type": "invoke_batch",
  "rsid": "rs_7f3a",
  "seq": 21,
  "payload": {
    "batch_id": "0197a3c2-0000-7000-8000-000000000020",
    "atomic": true,
    "timeout_ms": 120000,
    "steps": [
      {
        "invocation_id": "0197a3c2-0000-7000-8000-000000000021",
        "method": "send_code_to_revit",
        "params": {},
        "mutating": true,
        "policy": {
          "class": "confirm",
          "decision": "confirmed",
          "confirmation_id": "confirmation_uuid"
        }
      }
    ]
  }
}
```

Rules:

- Every step has its own canonical idempotency key and journal row; all steps share `batch_id`.
- Every step carries the same server-authored policy block required by an ordinary invocation. A batch MUST NOT combine a preview and its approved commit; all required confirmations must already bind to the exact step parameters before batching.
- With negotiated `batch_atomic`, `atomic:true` is sent to the add-in as one length-prefixed `execute_batch` request and executes under one Revit `TransactionGroup`.
- Without `batch_atomic`, `atomic:true` returns terminal `unsupported` without executing any step.
- `atomic:false` MAY execute by ordered bridge fan-out. It stops at the first failed step and returns `failed_step_index`; no atomicity is claimed.
- `execute_batch`, `mcp_status`, and unsupported UI-interactive commands MUST NOT be recursively nested as batch steps.
- The pilot artifact includes the adapted add-in and MUST demonstrate the `batch_atomic` path before cutover.

### 11.1 Batch result carrier

Every batch terminates with one `result` whose `payload.kind` is `batch`. `failed_step_index` is carried at
the top level of that payload, not hidden in a step result or metrics object:

```json
{
  "type": "result",
  "rsid": "rs_7f3a",
  "seq": 22,
  "payload": {
    "kind": "batch",
    "batch_id": "0197a3c2-0000-7000-8000-000000000020",
    "atomic": false,
    "status": "failed",
    "transaction_state": "not_applicable",
    "failed_step_index": 1,
    "steps": [
      {
        "index": 0,
        "invocation_id": "0197a3c2-0000-7000-8000-000000000021",
        "status": "completed",
        "result": {},
        "replayed": true
      },
      {
        "index": 1,
        "invocation_id": "0197a3c2-0000-7000-8000-000000000022",
        "status": "failed",
        "error": {
          "retryable": false,
          "fault_class": "revit_api",
          "message": "bounded operator-safe message"
        },
        "replayed": false
      },
      {
        "index": 2,
        "invocation_id": "0197a3c2-0000-7000-8000-000000000023",
        "status": "not_started",
        "replayed": false
      }
    ],
    "replayed": false
  }
}
```

Batch `status` is `completed`, `guarded`, `failed`, `cancelled`, or `indeterminate`.
`transaction_state` is `committed`, `rolled_back`, `not_applicable`, or `indeterminate`.
`failed_step_index` is `null` only when every step completed; otherwise it is the zero-based first
`guarded|failed|cancelled|indeterminate` step. Every input step appears exactly once and in input order.
A step status is `completed`, `guarded`, `failed`, `cancelled`, `indeterminate`, or `not_started`; exactly one
of `result` or `error` is present when applicable.

For `atomic:true`, success requires `transaction_state:"committed"`. A clean `TransactionGroup` rollback
uses `transaction_state:"rolled_back"`; no step may claim a committed mutation. If the add-in or bridge dies
after atomic dispatch without a durable terminal batch outcome, the whole batch uses
`status:"indeterminate"`, `transaction_state:"indeterminate"`, and every possibly executed mutating step is
indeterminate. `replayed:true` at batch level means that this delivery executed no add-in step.

## 12. Idempotency journal

### 12.1 Required storage behavior

The bridge MUST use a local durable SQLite-class store. The implementation language and database library are not part of RBP/1. The logical record contains:

```text
rsid, invocation_id, idempotency_key, batch_id?, batch_index?, method, mutating,
params_digest, state, terminal_outcome?, result_digest?, verification_hold?,
created_at, started_at?, finished_at?
```

Allowed states are:

```text
received -> executing -> completed|failed|guarded|cancelled|indeterminate
```

Durability ordering is mandatory:

1. Persist `received` and `params_digest` before the first add-in byte is written.
2. Persist `executing` before or atomically with dispatch ownership.
3. Persist the terminal outcome before sending `result` or `error` to the Gateway.

A crash after add-in completion but before terminal persistence leaves `executing` and is indeterminate by design.

`params_digest` is computed exactly as follows:

```text
canonical_params_bytes = UTF-8 without BOM of RFC 8785 JCS(params)
params_digest = "sha256:" + lowercase_hex(SHA-256(canonical_params_bytes))
```

The input is the functional `params` JSON value before display/audit side-channel fields are merged. Duplicate
keys and non-finite numbers are rejected before canonicalization. RFC 8785 object-key ordering and number
serialization apply; no additional Unicode normalization is performed. Therefore harmless JSON property
ordering or escape differences do not create a mismatch, while a real value change does. Implementations
MUST share golden vectors covering property order, number formatting, Unicode, and escapes.

The bridge also compares `method`, `mutating`, the full policy/confirmation block, and batch position
separately; a matching `params_digest` cannot authorize a changed method or policy. For a batch, a durable
coordination row additionally binds `batch_id`, `atomic`, ordered step invocation ids, methods, policy blocks,
and step `params_digest` values before any add-in byte is written.

### 12.2 Redelivery rules

For an existing canonical idempotency key:

1. A terminal row replays the stored outcome with `replayed:true`; the add-in is not called.
2. `received` or `executing` with `mutating:false` MAY be executed once more. This is a recovery/failure path, so the bridge MAY consult `mcp_status` first to avoid colliding with a still-running add-in task.
3. `received` or `executing` with `mutating:true` MUST NOT be re-executed. Return `journal_indeterminate` with
   `retryable:false`, `outcome:"indeterminate"`, and `verification_required:true`; the Gateway installs the
   recovery hold from Section 6.2 before any new invocation id is considered.
4. The same key with a different `params_digest` is a terminal `protocol` fault.

The journal MUST retain entries for at least seven days and longer than every supported resume/redelivery window. The Phase-1 implementation SHOULD default to 14 days. It MUST NOT prune non-terminal entries merely to satisfy a row cap. Large terminal results MAY retain only a digest and return `payload_omitted:true`; the Gateway then performs a read-based recovery instead of guessing.

#### `invoke_batch` redelivery

The batch coordination row is checked before any step row. A repeated `batch_id` with a changed `atomic`
value, ordered step identity, method, policy binding, or step digest is a terminal `protocol` fault.

For `atomic:false` redelivery:

1. Terminal prefix steps are replayed from their journals and never re-executed.
2. A terminal `guarded|failed|cancelled|indeterminate` step stops the batch; later steps are returned as
   `not_started`.
3. The first non-terminal read step MAY execute once under rule 2 above. The first non-terminal mutating step
   becomes `indeterminate`, stops the batch, and requires verification. Only after a recovered step is
   terminal-successful may ordered `not_started` successors execute.
4. The response always uses the Section 11.1 carrier. It may therefore contain a mix of replayed terminal,
   newly terminal, indeterminate, and `not_started` steps. `failed_step_index` identifies the first
   non-success step. Batch `replayed:true` is permitted only when no step executed during this delivery.

For `atomic:true` redelivery, a durable terminal batch outcome is replayed with identical semantics without calling
the add-in. A coordination row still in `received` may execute only when it durably proves that no add-in byte
was sent. Once atomic dispatch may have started, any missing terminal outcome makes the whole transaction and
all possibly mutating steps indeterminate; no individual step is retried. Read-only verification of the
intended postconditions is mandatory before another mutation, and inconclusive verification requires an
operator.

## 13. Partial results, progress, and backpressure

`partial` has two forms:

```json
{
  "kind":"chunk",
  "invocation_id":"...",
  "chunk_index":0,
  "encoding":"base64",
  "content_type":"application/json",
  "data":"eyJyZXN1bHQiOi4uLn0="
}
```

```json
{"kind":"progress","invocation_id":"...","progress":{"elapsed_ms":10000,"note":"waiting_for_revit"}}
```

- `encoding` is exactly `base64` in RBP/1. `data` is RFC 4648 standard padded Base64 with no whitespace.
  The 1 MiB chunk limit applies to decoded bytes, not Base64 text.
- Chunk payloads are ordered from `chunk_index:0`; a duplicate index must contain identical decoded bytes
  and is not appended twice. Sequence acknowledgement/retransmission follows Section 5.2.
- A chunked invocation ends with one terminal `result` carrying `chunked:true`, `content_type`,
  `total_chunks`, `total_size`, and `sha256`. `total_size` and `sha256:` plus lowercase hexadecimal SHA-256
  are computed over the concatenation of decoded chunk bytes in index order.
- Long-running add-in waits SHOULD emit progress every 10 seconds.
- The bridge pauses data emission while the transport's buffered outbound data exceeds 8 MiB.
- Control messages and heartbeats MUST remain serviceable while result chunks are backpressured.
- Total reconstructed result size is limited to 32 MiB. Larger results fail with `oversize`; Gateway-side `result_ref` hygiene is a separate layer and does not raise this wire limit.

## 14. Document context

The add-in maintains a thread-safe cached snapshot from application events such as document open/close and view activation. It serves that snapshot through `get_document_context` without an ExternalEvent/UI-thread round trip.

The bridge:

- polls `get_document_context` every 15 seconds
- polls immediately after registration/resume
- MAY poll after an invocation when it expects context to have changed
- sends `doc_context_update` only when the normalized snapshot differs

```json
{
  "type": "doc_context_update",
  "rsid": "rs_7f3a",
  "seq": 30,
  "payload": {
    "documents": [
      {
        "document_id": "digest-or-guid",
        "title": "Project A",
        "path_digest": "sha256:...",
        "is_workshared": true,
        "is_active": true
      }
    ],
    "active_document": "digest-or-guid",
    "active_view": {"id": "123", "name": "Level 2 HVAC", "type": "FloorPlan", "level": "Level 2"},
    "discipline_hint": "mech"
  }
}
```

Raw model paths SHOULD be represented by bounded metadata and digests according to the O7 privacy policy. The standing context watcher MUST NOT poll `get_current_view_info` plus `list_open_views` as a substitute for this cached command.

## 15. Error model

`error` payload:

```json
{
  "invocation_id": "optional",
  "retryable": false,
  "fault_class": "parameter",
  "outcome": "known",
  "verification_required": false,
  "message": "bounded operator-safe message",
  "addin_error": {"code": -32602, "message": "optional bounded detail"}
}
```

| `fault_class` | Default retryability | Meaning |
|---|---|---|
| `protocol` | false | Malformed envelope, sequence violation, key/digest mismatch; may close connection |
| `auth` | false | Device, resume-token, tenant, seat, or session authorization failure |
| `policy` | false | Invalid policy decision or missing confirmation correlation |
| `unsupported` | false | Unsupported method, capability, version, or atomic batch request |
| `parameter` | false | Invalid invocation parameters or add-in invalid-request/parse error |
| `environment` | true when non-mutating or known-not-dispatched | Transient transport/process/host condition with a known non-committing outcome; never a label for an unknown write |
| `revit_busy` | true | Failure-path diagnosis shows a competing/manual active Revit task |
| `revit_timeout` | read: true; write after dispatch: false | Deadline exceeded; a possibly dispatched write is promoted to `journal_indeterminate` |
| `revit_api` | false | Add-in command executed and returned/threw a Revit/API failure |
| `addin_unreachable` | true only before dispatch or for a safe read | Local TCP connect/reset or Revit exit; a possibly dispatched write is promoted to `journal_indeterminate` |
| `journal_indeterminate` | false | A mutating invocation may have executed; verification is required |
| `oversize` | false | Negotiated size limit exceeded |
| `cancelled` | false | Gateway abandoned the invocation; late real outcome remains journaled |

`outcome` is `known` unless the fault is `journal_indeterminate`, where it MUST be `indeterminate` and
`verification_required` MUST be true. Retryability is explicit on every error. The orchestrator, not the
bridge, owns bounded retry policy. A write is never blindly retried: after the first add-in byte may have been
sent, transport timeout, process loss, cancellation uncertainty, or add-in unreachability MUST be classified
through the journal. If non-execution cannot be proved, `journal_indeterminate` replaces the otherwise
retryable environment class and activates the Section 6.2 verification hold.

## 16. Cancellation

`cancel` is a sequenced data message:

```json
{
  "type": "cancel",
  "rsid": "rs_7f3a",
  "seq": 44,
  "payload": {
    "invocation_id": "0197a3c2-0000-7000-8000-000000000010",
    "reason": "user_requested"
  }
}
```

`reason` is the closed v1 enum `user_requested`, `client_disconnected`, `deadline_exceeded`, or
`gateway_shutdown`. Cancellation is best effort. The existing add-in ExternalEvent path has no abort contract.

- If the invocation has not reached the add-in, the bridge cancels and journals it.
- If it is already executing, the bridge marks the Gateway request abandoned, waits for the real add-in outcome, journals that outcome, suppresses it as the user-visible result, and returns `cancelled` only when the real outcome is known. Loss before a mutating terminal outcome returns `journal_indeterminate`, never a false cancellation success.
- Cancellation MUST NOT erase evidence of a model mutation that completed after abandonment.

## 17. Add-in pass-through contract

For ordinary invocations, the bridge forwards the add-in method and parameters through the existing length-prefixed JSON-RPC framing, with JSON-RPC `id = invocation_id`. The bridge merges only the add-in-recognized display/audit side-channel values (`taskName`, `wrapperAction`, `logicalToolName`, `parentTaskName`, `parentTaskId`, `suppressTaskStatusWindow`).

Existing method families are:

| Family | Methods |
|---|---|
| Context/UI reads | `get_current_view_elements`, `get_current_view_info`, `get_selected_elements`, `get_ui_state`, `list_open_views` |
| Discovery/inspection | `find_elements`, `inspect_levels`, `inspect_sheet_text`, `inspect_schedules`, `count_annotations` |
| Spatial | `extract_spatial_snapshot`, `get_spatial_change_state` |
| Navigation/view | `activate_view`, `close_view`, `clear_selection`, `focus_elements`, `open_existing_plan_for_element_level`, `section_box_elements`, `create_3d_view_for_elements`, `delete_review_view` |
| Dynamic execution | `send_code_to_revit` |
| Diagnostic pseudo-method | `mcp_status` |
| Pre-pilot adaptations | `execute_batch`, `get_document_context` |

Legacy raw/unframed JSON is never emitted by the bridge. The add-in framing detector remains for the planned compatibility window and retires one release after cutover.

## 18. Update-manifest touchpoint

RBP/1 defines transport shapes; O9 owns signing, rollout, download, apply, and rollback semantics.

`manifest_check` payload:

```json
{
  "bridge_version": "0.1.0",
  "addin_versions": ["2026.07.22.0"],
  "channel": "stable",
  "highest_accepted_release_sequence": 574
}
```

All fields are REQUIRED. `channel` is a bounded server-configured channel name; release sequence is a
non-negative JSON-safe integer.

`manifest_info` payload:

```json
{
  "status": "update_available",
  "channel": "stable",
  "latest_version": "0.2.0",
  "min_supported_version": "0.1.0",
  "release_sequence": 575,
  "rollout_cohort": "pilot",
  "manifest_url": "/bridge/update/manifest/575",
  "signature_url": "/bridge/update/manifest/575.sig"
}
```

`status` is the closed v1 enum `up_to_date`, `update_available`, or `update_required`. `channel`,
`latest_version`, `min_supported_version`, and `release_sequence` are REQUIRED. `rollout_cohort`,
`manifest_url`, and `signature_url` are REQUIRED when an update is available/required and absent otherwise.
Artifact URLs, hashes, platform files, and apply instructions live inside the signed O9 manifest rather than
being duplicated as unsigned RBP fields.

An update notice MAY also ride `hello_ack` or `heartbeat_ack`. A bridge MUST verify the signed manifest and anti-rollback sequence through O9 before applying it; transport receipt is not trust.

## 19. Limits

| Item | Phase-1 limit |
|---|---:|
| In-flight invocation/batch per `rsid` | 1 |
| Serialized invocation params | 4 MiB |
| Partial chunk | 1 MiB |
| Total reconstructed invocation result | 32 MiB |
| Control message | 64 KiB |
| `doc_context_update` | 256 KiB |
| Default invocation timeout | 120 seconds |
| Gateway timeout grace | 10 seconds |
| Pending-disconnect hold | 10 minutes |
| Session resume lifetime | 24 hours |
| Maximum `seq` / acknowledgement value | 9,007,199,254,740,991 (`2^53-1`) |

The bridge MUST reject oversize params before contacting the add-in. Negotiated values MAY lower these limits but cannot raise them above an implementation's safe local cap.

## 20. Security and audit requirements

- Every connection is TLS-authenticated by device token; the token MUST NOT appear in logs, diagnostics, or protocol traces.
- Resume tokens are scoped to device and `rsid`; cross-session resume fails closed.
- The Gateway binds tenant, authenticated user, device, `rsid`, policy decision, tool version, and idempotency key before dispatch.
- Session registration cannot choose its tenant, user, or seat; those are bound from authenticated device enrollment and recorded separately from the north-side OIDC actor.
- The bridge MUST accept invocations only for its registered sessions.
- Params and terminal outcomes are journaled with digests; secrets and full raw paths are excluded by policy.
- Every Gateway invocation produces exactly one audit record keyed by tenant plus the canonical idempotency key; redelivery updates that record instead of duplicating it.
- Approval is a separate audit event carrying actor, time, preview/action identity, and `confirmation_id`.
- `guarded=true` is protected product behavior and remains distinct from a failed operation.
- No successful transport acknowledgement is evidence that a model transaction committed; terminal result fields and journal state are authoritative.

## 21. Minimum conformance suite for v1.0 freeze

The implementation-independent harness uses a Gateway stub, bridge simulator, and exact add-in loopback framing fixture. Before v1.0 freeze it MUST cover:

1. Authenticated hello/version/capability negotiation
2. Version mismatch with manifest pointer and bounded reconnect behavior
3. Revoked device credential refusal
4. Multi-session discovery through bounded scan; explicit proof that no temp registry file is read
5. Registration and context snapshot
6. Heartbeat transitions at 35/65 seconds and reconnect on missing acknowledgement
7. Gateway restart plus session resume and bidirectional retransmission
8. Terminal journal replay with exactly one add-in execution
9. Indeterminate mutating invocation returns `journal_indeterminate` with zero re-executions
10. Indeterminate read invocation executes at most once more
11. Canonical-key params-digest mismatch fails as `protocol`
12. Authoritative window=1 rejection on one `rsid`, with parallel success across two `rsid` values
13. Proof that normal invokes do not send `mcp_status` preflight traffic
14. Failure enrichment using `mcp_status` after a simulated busy/timeout path
15. Ordered chunking, digest verification, progress, and backpressure
16. Params/result oversize rejection at the correct boundary
17. Cancellation with late real outcome preserved in the journal
18. Error mapping for method-not-found, invalid params, add-in exception, guarded result, and failure-shaped result
19. Exact 4-byte big-endian add-in framing vectors, including split/coalesced reads and the former 8192-byte case
20. `atomic:false` batch fan-out and failure index
21. `atomic:true` rejection without `batch_atomic`
22. `atomic:true` one-frame `execute_batch` success/rollback with `batch_atomic`
23. `get_document_context` propagation within 15 seconds without ExternalEvent polling
24. Duplicate/reordered data-frame handling across reconnect
25. Cross-device/cross-rsid resume and invocation authorization negatives
26. Gateway `N`/`N-1` compatibility plus within-version additive-change vectors
27. Reconnect full-jitter bounds, 60-second cap, and reset only after 120 seconds continuously steady
28. Pending-expiry mutation returns an indeterminate outcome, installs the verification hold, and blocks a new-id write until an audited verification read clears it
29. Mixed terminal/non-terminal `atomic:false` batch redelivery plus atomic terminal replay/indeterminate recovery
30. RFC 8785 `params_digest` golden vectors for property order, number formatting, Unicode, and escapes
31. `heartbeat_ack`, resume, cancel, goodbye, and manifest payload-schema positive/negative vectors
32. Chunk Base64 alphabet/padding, decoded-byte limit, reconstruction size, and decoded-content digest
33. Loopback-only discovery/connect rejection for wildcard, LAN, hostname-resolved remote, and override targets
34. Session document-schema and seat/user spoof rejection against authenticated enrollment
35. Maximum-safe `seq` acceptance, unsafe `2^53` rejection, no-wrap renewal, duplicate, and gap behavior
36. WSS-primary and Streamable HTTP/SSE fallback interop produce identical journal/resume outcomes

The required pilot stack additionally runs a real-add-in smoke covering each method family, one confirm-class write, forced reconnect, and one atomic batch.

## 22. v0.9 review checklist and v1.0 freeze blockers

The following remain open review items; v0.9 is intentionally not marked frozen:

- Freeze the Streamable HTTP/SSE fallback binding selected by DP-2 and attach proxy/interoperability evidence.
- Publish JSON Schemas under `packages/protocol` that match every payload and conditional envelope rule in this document.
- Confirm add-in capability/version fields exposed by `mcp_status` and `get_document_context`.
- Resolve the GAP-7 file-ingress/artifact-upload mechanism with the WP9 client evaluation; add only the selected capability-gated messages.
- Review batchable command restrictions with the add-in implementation owner.
- Run the conformance golden vectors and fold findings into this document.
- Confirm that the Gateway audit schema and bridge journal both materialize the exact RES-21 key.
- Record the review outcome in `docs/decisions/DP-log.md`; any normative change follows R-F.

M1 freezes this document as v1.0 only after the checklist is complete and the required conformance evidence is attached.
