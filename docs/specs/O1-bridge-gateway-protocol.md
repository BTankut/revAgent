# O1 Bridge-to-Gateway Protocol Specification

| Field | Value |
|---|---|
| Protocol name | RBP/1 (RevAgent Bridge Protocol, version 1) |
| Document version | 1.0 |
| Status | Normative RBP/1 v1.0; semantic freeze is established by the Section 22 protected-merge gate, while tag closure remains separate |
| Milestone | M1 closing accepted by the operator; effective when the green protected candidate is merged |
| Updated | 2026-07-25 |
| Owner | WP1 / O1 |

RBP/1 is the internal RPC protocol between the RevAgent Gateway and the thin desktop bridge. It is not MCP. MCP exists only at the Gateway north boundary. The bridge-to-add-in hop remains the existing length-prefixed JSON-RPC TCP protocol.

Normative precedence is:

1. `docs/TARGET_ARCHITECTURE.md`
2. `docs/implementation-plan/00-INDEX.md`
3. This specification
4. `docs/implementation-plan/01-protocol-O1.md`

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative requirements. Any implementation finding that invalidates a RES-* decision must use the R-F amendment process; implementations must not silently diverge.

## 1. INDEX amendment compliance

This v1.0 release candidate incorporates the coordinator resolutions that override the original package plan.

| Resolution | Canonical RBP/1 rule |
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
- Client-to-Gateway file upload, Gateway `artifact_ref` lifecycle, and Gateway north-MCP resource delivery.
  Section 13.1 defines only the RBP output carrier. WP2 owns Gateway ingress/storage/resource semantics and
  WP9 owns hands-on client interoperability under `docs/implementation-plan/00-INDEX.md` Section 4.

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
| `verification_hold_id` | Derived | Stable `vh:` digest over one `rsid`, one mutation scope, and the ordered canonical idempotency keys whose effects are unknown; correlation only, never the hold lookup key |
| `artifact_id` | Bridge | UUIDv7 for one sanitized output file within one invocation; stable across retransmission/replay and unique within that invocation |

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
The capability is provisioned in the signed enrollment/server profile so a bridge can select the fallback
when WSS cannot open; the bridge also declares it in `hello`, and the Gateway grants it in `hello_ack`.
An untrusted redirect or an unauthenticated discovery response cannot enable the fallback.

The fallback binding is frozen as follows:

1. The bridge first attempts WSS. When a retryable network/proxy/upgrade failure prevents WSS from opening,
   and only when `transport_streamable_http` is provisioned, it MAY try the fallback once within the same
   connection attempt. Authentication, authorization, version, or TLS-certificate failures never trigger a
   transport downgrade.
2. The bridge creates a fallback connection with `POST /bridge/v1/http/connections`. It sends the same
   `Authorization`, `X-RBP-Versions`, and TLS requirements as WSS, uses `Content-Type: application/json` and
   `Accept: application/json`, and places the complete unsequenced `hello` object in the request body.
3. Success is `201 Created` with `RBP-Connection-Id: <opaque>` and one `hello_ack` JSON object in the body;
   its `payload.connection_id` MUST match the header exactly. The connection id is bound to the authenticated
   device and is not an actor credential. It MUST NOT be
   accepted without the same bearer credential on later requests.
4. The bridge then opens `GET /bridge/v1/http/connections/{connection_id}/events` with
   `Accept: text/event-stream`. A `200` response establishes the Gateway-to-bridge stream. Each RBP object is
   one SSE event with `event: rbp` and exactly one UTF-8, single-line JSON `data:` value. SSE `id` and
   `Last-Event-ID` are not RBP sequence authority and MUST NOT be used for replay. Comment-only keepalives are
   allowed and do not replace RBP heartbeat/ack messages.
5. Bridge-to-Gateway messages use
   `POST /bridge/v1/http/connections/{connection_id}/messages`, one complete RBP object per
   `application/json` request. Success is `202 Accepted` only after durable transport acceptance. Lifecycle
   control requests are serialized; session data requests are serialized per `rsid`, while distinct sessions
   and connection heartbeats may use independent HTTP/2 streams. RBP `seq`, not HTTP completion order, remains
   data ordering authority.
6. The bridge sends `session_register` or `session_resume` only after the SSE request returns `200`. Gateway
   data after `hello_ack` is emitted only on the SSE stream. An SSE EOF/reset, an unknown/expired connection
   id (`404`/`410`), or an uplink request whose durable acceptance is unknown ends that transport connection.
   The bridge creates a new connection, performs `hello` again, resumes each `rsid`, and relies on RBP
   acknowledgement plus journal redelivery; it never reattaches with `Last-Event-ID`.
7. The same message and reconstructed-result limits apply before Base64/SSE expansion. Intermediaries MUST
   disable response buffering and compression transformations that delay SSE delivery; proxy evidence MUST
   show heartbeat, progress, cancellation, forced EOF, and resume behavior.

The fallback never switches an active WSS connection in place. One connection cycle has at most one active
binding, and transport selection does not change invocation identity or journal state.

### 4.2 Connection opening

After transport authentication:

1. Bridge sends `hello` as the first protocol message.
2. Gateway returns `hello_ack` selecting exactly one protocol version and a capability intersection.
3. Any non-`hello` first message closes the connection with protocol error `4400`.
4. No version overlap closes with `4426` and an update-manifest pointer.
5. Authentication loss closes with `4401`; authorization/seat refusal closes with `4403`.

Connection-opening failures occur before an RBP invocation error can be delivered and are handled as follows:

| Opening outcome | Treatment |
|---|---|
| DNS/TCP timeout or reset; proxy/upgrade rejection that does not authenticate; HTTP `408`, `429`, `502`, `503`, or `504` | Connection-scoped retryable `environment` condition. Try the provisioned fallback once when eligible, then apply Section 4.3. Honor a valid bounded `Retry-After` as an additional server delay. |
| HTTP `401`/`403` or WSS close `4401`/`4403` | `auth`/authorization refusal. Do not try the fallback and pause automatic retries until credential, enrollment, seat, or operator state changes. |
| HTTP `426` or WSS close `4426` | `unsupported` protocol window. Follow the signed manifest/update path; do not reconnect unchanged. |
| Certificate, hostname, or trust-chain validation failure | Local terminal security configuration fault. Do not downgrade transport or disable certificate validation; pause until trust/configuration changes. |
| Malformed `hello_ack`, unexpected successful status/body, or a message before `hello_ack` | `protocol` fault; close the partial connection and apply bounded backoff after recording safe diagnostics. |

For this table, `Retry-After` is accepted only as a non-negative delta-seconds value or a valid HTTP-date no
more than 15 minutes in the future. The next attempt waits the greater of that value and the Section 4.3
full-jitter delay; malformed, negative, or farther-future values are ignored and audited. This server delay
does not reset or skip the attempt index.

No opening failure fabricates a terminal outcome for an already journaled invocation. Resumable work follows
Sections 6.2 and 12; pending-window expiry preserves the mutating indeterminate rule.

### 4.3 Reconnect backoff

The retry wait uses a zero-based attempt index. The first automatic retry after a failed connection cycle uses
`n=0`; each later unsuccessful cycle uses `n=1`, `n=2`, and so on. A connection that leaves `steady` before
120 continuous seconds also consumes the next index. Before that automatic attempt, the bridge waits:

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
The Gateway serializes accepted WSS frames in receive order. A malformed or oversized frame and the
WebSocket implementation's corresponding `error` event are contained to that connection, which is closed
and durably disconnected without terminating the Gateway process; repeated close/error notifications are
idempotent.

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

- `hello` and `hello_ack` are the only pre-negotiation objects and MUST omit top-level `v`;
  `hello_ack.payload.protocol` selects it. Every later object requires `v` equal to that selected integer for
  the life of the connection.
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
    "result_contract_version": 2,
    "session_capabilities": ["batch_atomic", "doc_context_cached_v1"],
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
    "seat": {"granted": true, "seat_id": "seat_uuid"},
    "granted_session_capabilities": ["batch_atomic", "doc_context_cached_v1"]
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

`addin_version`, `result_contract_version`, and `session_capabilities` are REQUIRED per local Revit session.
The bridge derives them from successful loopback shape/capability probes; it MUST NOT infer them from a file
name or Revit version. The v1 session capability names are `batch_atomic` and `doc_context_cached_v1`.
`batch_atomic` requires working `execute_batch`; `doc_context_cached_v1` requires working
`get_document_context`. Unknown capability names are ignored within RBP/1. The Gateway returns only the
intersection it accepts in `granted_session_capabilities`, and dispatch MUST test that per-`rsid` grant rather
than a connection-wide version string. The adapted pilot add-in MUST expose the source version/capability data
through its `mcp_status`/`get_document_context` contract; absence or contradiction fails that session's pilot
registration rather than being guessed.

Revit exit sends this unsequenced control message:

```json
{
  "type": "session_unregister",
  "payload": {
    "rsid": "rs_7f3a",
    "reason": "revit_exited"
  }
}
```

Both fields are REQUIRED. `reason` is the closed v1 enum `revit_exited`, `bridge_shutdown`,
`session_replaced`, or `operator_requested`. Acceptance revokes that session's resume token and prevents new
dispatch. Pending invocations end with `addin_unreachable` only when non-execution is known. A possibly
dispatched mutation follows the indeterminate rules below; unregistration never fabricates a known failure or
clears a recovery hold.

The Gateway persists the revoked session record, including its authenticated device, tenant, user, seat, and
`reason`. A `session_unregister` from a later active connection owned by that same authenticated
device/tenant/user/seat revokes a still-active session even when it remains bound to the prior connection; an
exact replay is an idempotent no-op even though the `rsid` is no longer bound and its resume token is revoked.
Unknown sessions, cross-owner replays, and a replay whose `reason` differs from the persisted revocation fail
with `4403`. A bridge with a durable pending-unregister tombstone MUST replay
`session_unregister` directly on each fresh binding; it MUST NOT resume the revoked session first.

The Gateway stores that v1 tombstone at the tenant-scoped key `(tenantId, rsid)` in
`gateway.rbp-unregister/v1`. Its frozen DC-01 fields are `version`, authenticated owner, `reason`,
`revokedAtMs`, `byConnectionId`, and the normalized pending disposition. Creation atomically writes the
tombstone and changes the legacy `gateway.rbp-session/v1` row to non-resumable/non-dispatchable; readback of
the exact tombstone is required before returning success. Until WP-10 owns a successor schema, admission reads
the v1 session/tombstone union fail-closed and does not claim v2 normalization or migration.

The bridge revokes local dispatch as soon as it durably records unregister intent. It MUST NOT mutate local
lifecycle or outbound-queue authority before that journal transaction commits. If a post-commit durability
operation reports an error, the bridge re-reads the exact tombstone: an observed matching intent revokes local
authority fail-closed without sending, while an absent or conflicting intent leaves local state unchanged and
the original error is returned. It retains the tombstone across send failure, reconnect, and restart. The
tombstoned `rsid` is excluded from a connection heartbeat only after its `session_unregister` send has
completed on that connection.

The durable tombstone has `pending` and `confirmed` phases. A `heartbeat_ack` for a subsequent heartbeat
processed in receive order atomically changes it to `confirmed`, queues artifact expiry, and removes retained
session sequence/outbox state; successful transport send alone is not processing evidence. The live add-in
session is then removed before fallible spool cleanup. The confirmed tombstone remains until cleanup succeeds,
so a crash or cleanup exception cannot make the revoked session resumable. Restart retries confirmed cleanup
idempotently and deletes the tombstone only as the final completion step.

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
- If atomic replacement of Gateway state reaches canonical rename but subsequent directory durability
  confirmation fails, the renamed draft becomes live fail-closed authority and the store is poisoned: the
  original error is returned and later dispatch/state updates are rejected until restart/recovery. A failure
  before canonical replacement MUST leave both live and canonical authority unchanged.
- Redelivered invokes always pass through the bridge journal rules in Section 12.

A fresh `hello`/`hello_ack` binding does not inherit dispatch or heartbeat authority for a durable bridge
session. The bridge keeps each such session non-dispatchable and omits connection heartbeats until its
`resume_ack` is received. Test fixtures MAY opt into an explicit assume-bound mode, but production defaults
MUST fail closed. Pending-unregister tombstones use the direct idempotent replay rule in Section 6.1 instead of
resume.

After the 10-minute pending window, outcome handling depends on mutation risk:

- A non-mutating invocation whose durable terminal outcome is unavailable MAY end as `environment` with
  `retryable:true`, provided no concurrent execution remains possible.
- A mutating invocation whose dispatch or commit cannot be disproved MUST end as `journal_indeterminate`
  with `retryable:false`, `outcome:"indeterminate"`, and `verification_required:true`.

#### 6.2.1 Mutation recovery hold

The canonical idempotency key identifies the uncertain operation; it is not the key used to block later
mutations. Every invocation and batch step carries a server-authored `mutation_scope`: it is `null` for an
ordinary read and is REQUIRED to be one of these objects for `mutating:true`:

```json
{"kind":"session"}
```

```json
{"kind":"document","document_id":"doc_session_stable_id"}
```

The Gateway uses document scope only when the target is one exact document currently registered under that
`rsid`; implicit-active-document, multi-document, UI-global, or otherwise uncertain writes use the conservative
session scope. A session scope conflicts with every mutation scope under that `rsid`; a document scope conflicts
with the same document scope and any session scope. Unknown scope kinds or a document not registered to the
session are terminal `protocol` faults.

For each distinct conflicting scope whose effect is unknown, both Gateway and bridge persist an active hold
indexed by `(rsid, mutation_scope)`, not by the next invocation id. Its stable correlation id is:

```text
hold_material = {"mutation_scope":<scope>,"origin_idempotency_keys":[<ordered keys>],"rsid":<rsid>}
verification_hold_id = "vh:" + lowercase_hex(SHA-256(UTF-8-without-BOM(RFC8785-JCS(hold_material))))
```

For one invocation the origin list has one key. For an uncertain atomic batch, each scope's list contains, in
input order, every possibly executed mutating step key in that scope. If any uncertain step uses session scope,
one session hold contains all possibly executed mutating origin keys and subsumes document holds for that
batch; otherwise there is one hold per affected document. Before minting or dispatching **every** new mutating
invocation or batch, the Gateway MUST query its durable conflict index. Before writing the first add-in byte,
the bridge MUST perform the same check against its durable local index. An active conflict returns the original
hold's `journal_indeterminate` error without add-in contact even when `invocation_id` or `batch_id` is fresh.
Redelivery of an origin key and a correlated read-only verification are the only operations exempt from this
block.

A verification read is an ordinary `mutating:false` `invoke` with this server-authored correlation block:

```json
{
  "verification": {
    "hold_id": "vh:9c6c84634429ac77c06a69a975688e815a44217a9e47c7a845dd7da4dbcb6a7b",
    "mutation_scope": {"kind":"document","document_id":"doc_session_stable_id"},
    "purpose": "resolve_indeterminate"
  }
}
```

The bridge validates the active hold before executing the read and journals `hold_id`, scope, verification
`invocation_id`, and terminal raw-response digest together. A successful read is evidence, not clearance.
The hold remains blocking when the read fails, is omitted, is ambiguous, or cannot prove either non-execution
or the intended postcondition; operator intervention is then REQUIRED.

Clearance has the deterministic state transition
`active -> evidence_recorded -> resolved_pending_bridge -> cleared`. After an audited Gateway decision, exactly
one next mutation may carry this entry in `recovery_clearances[]`:

```json
{
  "hold_id": "vh:9c6c84634429ac77c06a69a975688e815a44217a9e47c7a845dd7da4dbcb6a7b",
  "mutation_scope": {"kind":"document","document_id":"doc_session_stable_id"},
  "resolution_id": "0197a3c2-0000-7000-8000-000000000101",
  "basis": "verification_read",
  "verification_invocation_id": "0197a3c2-0000-7000-8000-000000000099",
  "evidence_digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  "decision": "postcondition_verified",
  "audit_id": "0197a3c2-0000-7000-8000-000000000102"
}
```

Every displayed field is REQUIRED. `basis` is `verification_read` or `late_terminal`;
`verification_invocation_id` is a UUIDv7 for the former and explicit `null` for the latter. `decision` is
`non_execution_proven` or `postcondition_verified`. No `inconclusive` value is a clearance: an inconclusive
attempt is retained as evidence while the hold stays `active`. `hold_id` is `vh:` plus 64 lowercase
hexadecimal characters; `evidence_digest` is `sha256:` plus 64 lowercase hexadecimal characters;
`resolution_id` and `audit_id` are Gateway-minted UUIDv7 values. A `recovery_clearances` array has unique
`hold_id` values sorted by ascending Unicode code point so its batch-digest representation is deterministic;
it contains every and only active hold that conflicts with that envelope's mutation scopes.

The Gateway permits only that evidence-bound envelope while `resolved_pending_bridge`; every unrelated
mutation remains blocked. The bridge MUST match the clearance to its active hold and durable evidence, then
atomically mark the hold `cleared` with acceptance of the new invocation before any add-in byte. A mismatch is
a terminal `protocol` fault. Durable acceptance/acknowledgement lets the Gateway finish the same transition.
Duplicate delivery of the identical envelope is idempotent; a changed clearance is not.

If a real add-in outcome becomes durable after `journal_indeterminate`, the bridge stores it as late evidence
without overwriting the original indeterminate classification or clearing the scope. Redelivery of the origin
key returns that durable outcome with `replayed:true`, `late_after_indeterminate:true`,
`verification_hold_id`, and its exact result digest. The Gateway may use a conclusive late terminal as the
`late_terminal` clearance basis; otherwise it still requires the correlated verification read. Hold creation,
every verification attempt, resolution, late evidence, and clearing are retained for at least the journal
retention period and linked in audit by hold/resolution ids.

Changing `invocation_id`, changing `batch_id`, reconnecting, re-registering the same resumable session, a
transport timeout, process exit, or `addin_unreachable` signal MUST NOT bypass or downgrade this hold.

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
    "artifact_result_v1",
    "transport_streamable_http"
  ],
  "bridge_version": "0.1.0",
  "device_id": "device_uuid",
  "machine": {"hostname": "WS01", "os": "Windows 11"},
  "addin_versions": ["2026.07.22.0"]
}
```

`hello.capabilities` describes connection/bridge implementation features. Add-in-dependent features are
declared and granted per session under Section 6.1; in particular, `batch_atomic` is not inferred from a
connection-wide `addin_versions` list. `transport_streamable_http` does not switch the active connection in
place. `artifact_result_v1` enables the constrained output path in Section 13.1.

### 7.2 `hello_ack`

Required payload:

```json
{
  "protocol": 1,
  "connection_id": "conn_uuid",
  "granted_capabilities": [
    "journal_v1",
    "chunked_results",
    "artifact_result_v1",
    "transport_streamable_http"
  ],
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

Gateway processing of connection envelopes is receive-order serialized. Consequently, a `heartbeat_ack`
proves processing of lifecycle controls ordered before that heartbeat on the same binding. Because the ack
does not echo a heartbeat id, a bridge finalizing unregister tombstones MUST use one current-connection fence
snapshot at a time: a stale or unsolicited `heartbeat_ack` cannot finalize it, the returned `acks` set must
exactly match the non-tombstoned sessions in the fenced heartbeat, and all data acknowledgements must validate
before tombstone deletion.

The bridge MUST keep heartbeats globally single-flight: while one heartbeat awaits `heartbeat_ack`, it MUST
NOT emit another heartbeat. It installs the acknowledgement deadline, exact active-session set, and any
unregister-confirmation tombstones before handing the heartbeat to the transport. A synchronous or re-entrant
`heartbeat_ack` delivered while transport send is still completing consumes that flight; send completion MUST
NOT re-arm it. The flight is bound to the current transport object and connection generation; an ACK observed
from an older binding cannot consume a newer flight. ACK handling synchronously captures and consumes one
immutable flight snapshot before any outbound flush may yield, and only that snapshot's tombstones may be
confirmed. While that ACK handler is active, no new heartbeat flight may start. An unsolicited current-binding
ACK may retain backward-compatible cumulative-data/liveness behavior but has no flight confirmations and can
never finalize a tombstone. A failed send rolls back only the still-current flight before reconnect/retry.

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
    "mutation_scope": null,
    "policy": {
      "class": "auto",
      "decision": "auto",
      "confirmation_id": null
    },
    "verification": null,
    "recovery_clearances": [],
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
- `mutation_scope`, `verification`, and `recovery_clearances` are REQUIRED fields. `mutation_scope` is `null`
  exactly for non-mutating calls and follows Section 6.2.1 for mutations. `verification` is `null` except on a
  correlated read-only verification. `recovery_clearances` is an array, empty unless Section 6.2.1 authorizes
  the envelope; bridge-local code never invents any of these values.
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
    "payload_omitted": false,
    "late_after_indeterminate": false,
    "metrics": {
      "execute_ms": 425,
      "request_bytes": 512,
      "response_bytes": 4096,
      "framing": "length-prefixed"
    }
  }
}
```

For `kind:"invocation"`, `status` is `completed` or `guarded`. A guarded add-in result remains a result, not
a transport failure. `guarded_reason` is REQUIRED exactly when `status:"guarded"` and MUST be absent for
`completed`. It is a stable lower-snake-case reason code of 1–64 ASCII characters
(`[a-z][a-z0-9_]{0,63}`), derived from the add-in's `reason`/`guardedReason`; when a legacy guarded payload has
no usable code, the bridge uses `unspecified_guarded` and preserves the original bounded detail inside
`result`. Add-in `resultContractVersion` is passed through without coupling it to RBP version.

`payload_omitted` defaults to false. When false, `result` is REQUIRED. `payload_omitted:true` is legal only on
a journal replay (`replayed:true`) of a terminal `completed` or `guarded` outcome whose original payload is no
longer retained; `result` MUST then be absent and `result_digest` is REQUIRED. `result_digest` is `sha256:`
plus lowercase hexadecimal SHA-256 of the exact raw UTF-8 add-in JSON-RPC response body bytes after removing
the 4-byte length prefix and before parsing or RBP wrapping.
`result_digest` is also REQUIRED, while retaining the full `result`, for a terminal read carrying a non-null
Section 6.2.1 `verification` correlation. The bridge journals and returns that same digest so a later
`recovery_clearances[].evidence_digest` can be checked independently by both peers.
Omission is not success evidence: the Gateway MUST perform an audited read-based recovery/verification and
MUST NOT reconstruct or blindly repeat a mutation. First delivery MUST NOT omit its terminal payload.

`late_after_indeterminate` defaults to false. It may be true only on a journal replay of a durable outcome
recorded after the same invocation had produced `journal_indeterminate`; `replayed:true`,
`verification_hold_id`, and `result_digest` are then REQUIRED. It is recovery evidence under Section 6.2.1,
not a second user-visible execution result and not automatic permission for another mutation.

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
    "recovery_clearances": [],
    "steps": [
      {
        "invocation_id": "0197a3c2-0000-7000-8000-000000000021",
        "method": "delete_review_view",
        "params": {
          "viewName": "revAgent_QA_fixture_disposable",
          "viewType": "ThreeD",
          "exactName": true,
          "mode": "commit",
          "confirmDelete": true
        },
        "params_digest": "sha256:b47279d1beb5a2a0b21098abb92fa98bacc01528b3ca2c475239e8c1754fd5a4",
        "mutating": true,
        "mutation_scope": {"kind":"document","document_id":"doc_session_stable_id"},
        "policy": {
          "class": "confirm",
          "decision": "confirmed",
          "confirmation_id": "confirmation_uuid"
        }
      }
    ],
    "batch_digest": "sha256:c0d85d9f7b43d4ad4c9091b3213574c6fd9accf1250ffa4c45260925618fae41"
  }
}
```

Rules:

- Every step has its own canonical idempotency key and journal row; all steps share `batch_id`.
- Every step carries the same server-authored policy block required by an ordinary invocation. A batch MUST NOT combine a preview and its approved commit; all required confirmations must already bind to the exact step parameters before batching.
- `params`, `params_digest`, and `mutation_scope` are REQUIRED on every step; `params` MUST NOT be omitted or
  replaced by its digest. The bridge recomputes Section 12.1's digest over the present functional `params` and
  rejects any mismatch after durable RBP transport-sequence acceptance/ACK advancement, but before an
  invocation journal row or add-in dispatch. `mutation_scope` is `null` exactly for a read step.
- Top-level `recovery_clearances` is REQUIRED and may be empty. Correlated verification reads MUST be sent as
  individual `invoke` messages and MUST NOT be hidden inside a batch. The Gateway and bridge check every step
  scope plus all supplied clearances against Section 6.2.1 before any step is dispatched.
- `batch_digest` is REQUIRED and is computed over the unambiguous semantic representation below. The bridge
  recomputes it after durable RBP transport-sequence acceptance/ACK advancement and rejects a mismatch before
  creating any step journal row or contacting the add-in:

  ```text
  batch_digest_material = {
    "atomic": atomic,
    "batch_id": batch_id,
    "recovery_clearances": recovery_clearances,
    "steps": [
      {"invocation_id":...,"method":...,"mutating":...,"mutation_scope":...,
       "params_digest":...,"policy":{"class":...,"confirmation_id":...,"decision":...}}, ...
    ],
    "timeout_ms": timeout_ms
  }
  batch_digest = "sha256:" + lowercase_hex(
    SHA-256(UTF-8-without-BOM(RFC8785-JCS(batch_digest_material))))
  ```

  All displayed fields are present; `confirmation_id` is explicitly `null` when unused. Input step order is
  preserved. `display` is not a batch-step field. There is therefore no omitted-step, raw-JSON, or implicit
  default representation from which a different digest may be derived.
- With `batch_atomic` in that `rsid`'s `granted_session_capabilities`, `atomic:true` is sent to the add-in as one length-prefixed `execute_batch` request and executes under one Revit `TransactionGroup`.
- Without `batch_atomic`, `atomic:true` returns terminal `unsupported` without executing any step.
- `atomic:false` MAY execute by ordered bridge fan-out. On the first delivery it stops at the first
  `guarded|failed|cancelled|indeterminate` step; every later input step is `not_started`. It returns
  `failed_step_index` for that first non-success step; no atomicity is claimed. In particular, a guarded step
  never allows the next step to run merely because it arrived in a `result` rather than an `error`.
- An `atomic:true` step MUST be in the exact session-local Appendix A.2 descriptor set. Raw dynamic code,
  `execute_batch`, `mcp_status`, and unsupported UI-interactive commands MUST NOT be nested as atomic steps.
- Every `invoke_batch` step, including `atomic:false` fan-out, MUST be present in the probed Appendix A.2
  descriptor set with `resultDelivery:"inline_only"`; otherwise the bridge returns `unsupported` before
  dispatching any step. Nested batch steps never use Section 13 chunk or artifact carriers. A conforming
  add-in therefore keeps each batch result JSON-inline and path-free within the negotiated result limit.
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
          "outcome": "known",
          "verification_required": false,
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
of `result` or `error` is present when applicable. A guarded step requires `guarded_reason` under Section
10.3. A completed/guarded step MAY use the same replay-only `payload_omitted` plus `result_digest` contract;
`not_started` never carries result, error, or omission fields.

A nested batch `error` uses the complete Section 15 invocation-error body except that `invocation_id` is
carried by the enclosing step. `retryable`, `fault_class`, `outcome`, `verification_required`, and `message`
are all REQUIRED. For `journal_indeterminate`, `verification_hold_id` and `mutation_scope` are also REQUIRED;
`outcome` is `indeterminate` and `verification_required` is true. A nested error MUST NOT rely on batch status
to supply or infer any of those fields.

Batch `status` normally matches the first non-success step. There is one narrow aggregate exception for
`atomic:true`: when dispatch may have started but the complete add-in terminal carrier is unavailable, an
unrecoverable read-only step result is `failed` with retryable `environment`, `outcome:"known"`, and
`verification_required:false`; it MUST NOT be fabricated as `completed`. Every possibly executed mutating
step remains `journal_indeterminate`. The aggregate batch and transaction stay `indeterminate` whenever such
a mutating step exists, while `failed_step_index` identifies the earliest unavailable read or indeterminate
mutation. No other earlier failure class may be hidden behind aggregate `status:"indeterminate"`.
If the same missing carrier belongs to an all-read atomic batch, every unavailable read is returned as that
known `environment` failure; the aggregate uses `status:"failed"`, `transaction_state:"rolled_back"`, and
`failed_step_index:0`. This is the only `failed|rolled_back` atomic carrier that may contain more than one
non-success step instead of a `not_started` suffix, because fabricating a result or non-execution claim for
any possibly executed read is forbidden.

If an attested inline-only command nevertheless returns artifact-shaped data or exceeds the negotiated inline
result limit after dispatch, the bridge MUST NOT create an unreachable spool carrier. The affected step stops
the remaining `atomic:false` fan-out with `status:"failed"`, `fault_class:"protocol"`, and explicit
`effect_state:"read_only"|"committed"|"not_committed"`. When the add-in reported a completed mutation, the
terminal delivery-fault row uses `effect_state:"committed"` rather than becoming a normal replayable success,
so a crash cannot run later batch successors. The delivery fault never discards the known model effect. The
raw artifact/path payload is neither journaled nor placed on the wire.

For `atomic:true`, success requires `transaction_state:"committed"`. A clean `TransactionGroup` rollback
uses `transaction_state:"rolled_back"`; no step may claim a committed mutation. Cancellation observed after
the one-frame atomic dispatch cannot rewrite the add-in's known transaction result: the user-visible batch and
abandoned step use `status:"cancelled"`, while `transaction_state` remains `committed` or `rolled_back` exactly
as reported by the add-in. That cancelled step carries `effect_state:"committed"|"not_committed"` for a
mutation, or `effect_state:"read_only"` for a read, so cancellation never hides a known model effect. If the
add-in or bridge dies
after atomic dispatch without a durable terminal batch outcome, the whole batch uses
`status:"indeterminate"`, `transaction_state:"indeterminate"`, and every possibly executed mutating step is
indeterminate. `replayed:true` at batch level means that this delivery executed no add-in step.

## 12. Idempotency journal

### 12.1 Required storage behavior

The bridge MUST use a local durable SQLite-class store. The implementation language and database library are not part of RBP/1. The logical record contains:

```text
rsid, invocation_id, idempotency_key, batch_id?, batch_index?, method, mutating, mutation_scope,
params_digest, state, terminal_outcome?, result_digest?, verification_hold_id?,
verification_correlation?, late_terminal_outcome?, late_result_digest?,
created_at, started_at?, finished_at?
```

The hold store is a distinct durable relation, not an invocation-row flag:

```text
rsid, scope_jcs, verification_hold_id, ordered_origin_idempotency_keys,
state(active|evidence_recorded|resolved_pending_bridge|cleared),
verification_invocation_id?, evidence_digest?, resolution_id?, resolution_basis?,
resolution_decision?, audit_id?, created_at, cleared_at?
```

`scope_jcs` is the exact RFC 8785 JCS string of `mutation_scope`. A uniqueness constraint prevents two
uncleared rows for the same `(rsid,scope_jcs)`; the conflict query additionally makes the session-scope row
conflict with every document row under the same `rsid`. Hold and invocation/journal transitions required by
Section 6.2.1 occur in one local transaction where they meet.

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

The bridge also compares `method`, `mutating`, `mutation_scope`, the full policy/confirmation block, and batch
position separately; a matching `params_digest` cannot authorize a changed method, scope, or policy. For a
batch, the explicit on-wire step `params_digest` is first verified against the present `params`, then the
Section 11 canonical `batch_digest` is verified. A durable coordination row binds that `batch_digest`,
`batch_id`, `atomic`, timeout, recovery clearances, and the complete ordered step representation before any
add-in byte is written. Step omission is invalid; no journal path reconstructs a batch from a prefix or from
digest-only steps.

### 12.2 Redelivery rules

For an existing canonical idempotency key:

1. A known terminal row replays the stored outcome with `replayed:true`; the add-in is not called.
2. An indeterminate row with a later durable terminal outcome returns that outcome as evidence-only replay
   with `replayed:true`, `late_after_indeterminate:true`, `verification_hold_id`, and the exact late-result
   digest; the add-in is not called and the Section 6.2.1 hold is not automatically cleared.
3. `received` or `executing` with `mutating:false` MAY be executed once more. This is a recovery/failure path,
   so the bridge MAY consult `mcp_status` first to avoid colliding with a still-running add-in task.
4. `received` or `executing` with `mutating:true` MUST NOT be re-executed. Return `journal_indeterminate` with
   `retryable:false`, `outcome:"indeterminate"`, `verification_required:true`, `verification_hold_id`, and
   `mutation_scope`; install the Section 6.2.1 scope hold before any fresh id is considered.
5. The same key with a different `params_digest`, method, scope, policy, clearance, or batch binding is a
   terminal `protocol` fault.

The journal MUST retain entries for at least seven days and longer than every supported resume/redelivery
window. The Phase-1 implementation SHOULD default to 14 days. It MUST NOT prune non-terminal entries or any
`active|evidence_recorded|resolved_pending_bridge` hold merely to satisfy a row cap; cleared holds and their
evidence remain for at least the journal retention period. Large terminal results MAY retain only a digest and
return `payload_omitted:true` under the exact Section 10.3 field conditions; the Gateway then performs a
read-based recovery instead of guessing.

#### `invoke_batch` redelivery

The batch coordination row is checked before any step row. A repeated `batch_id` with a changed verified
`batch_digest` or any changed `atomic`, timeout, clearance, ordered step identity, method, mutation scope,
policy binding, canonical params value, or step digest is a terminal `protocol` fault. Harmless JSON property
order/escape reserialization that yields the same RFC 8785 value is not a mismatch.

For `atomic:false` redelivery:

1. Terminal prefix steps are replayed from their journals and never re-executed.
2. A terminal `guarded|failed|cancelled|indeterminate` step stops the batch; later steps are returned as
   `not_started`.
3. The first non-terminal read step MAY execute once under the invocation redelivery rule 3 above. The first
   non-terminal mutating step
   becomes `indeterminate`, installs its Section 6.2.1 scope hold, stops the batch, and requires correlated
   verification. Only after a recovered step is terminal-successful may ordered `not_started` successors
   execute, and only when no active hold conflicts with a successor mutation.
4. The response always uses the Section 11.1 carrier. It may therefore contain a mix of replayed terminal,
   newly terminal, indeterminate, and `not_started` steps. `failed_step_index` identifies the first
   non-success step. Batch `replayed:true` is permitted only when no step executed during this delivery.

For `atomic:true` redelivery, a durable terminal batch outcome is replayed with identical semantics without calling
the add-in. A coordination row still in `received` may execute only when it durably proves that no add-in byte
was sent. Once atomic dispatch may have started, any missing terminal outcome makes the whole transaction and
all possibly mutating steps indeterminate; no individual step is retried. One Section 6.2.1 hold is installed
per distinct conflicting mutation scope with the ordered possibly executed step keys as origins. Read-only
verification of the intended postconditions is mandatory before another conflicting mutation, and
inconclusive verification keeps every affected scope blocked until an operator-backed conclusive resolution.
Any read result lost with that missing carrier is terminalized as the narrow known `environment` failure from
Section 11.1, never as a synthetic success. On restart recovery, the resulting batch and all returned terminal
steps use `replayed:true` because the recovery delivery executes no add-in step.

## 13. Partial results, progress, and backpressure

`partial` has two forms:

```json
{
  "kind":"chunk",
  "invocation_id":"...",
  "stream_id":"result",
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
- `stream_id` is REQUIRED and identifies one reconstruction stream within the invocation. `result` is reserved
  for a chunked structured-result stream; an artifact stream uses `artifact:<artifact_id>`. `chunk_index` starts
  at zero independently for each stream. A duplicate `(invocation_id,stream_id,chunk_index)` must contain
  identical decoded bytes and is not appended twice; reuse with different bytes is a `protocol` fault.
  Sequence acknowledgement/retransmission follows Section 5.2 and preserves all stream identity fields.
- An artifact chunk additionally requires `artifact_id` and zero-based `artifact_index`; they MUST match its
  `stream_id` and the terminal Section 13.1 descriptor. Those fields MUST be absent on `stream_id:"result"`.
  Every chunk in one stream has the same `content_type`, which also matches its terminal descriptor.
- A chunked non-artifact result ends with one terminal `result` carrying `chunked:true`,
  `stream_id:"result"`, `content_type`, `total_chunks`, `total_size`, and `sha256`. Artifact streams use their
  own terminal descriptors under Section 13.1. Every size and `sha256:` plus lowercase hexadecimal SHA-256 is
  computed per stream over decoded chunk bytes in index order; bytes from different streams are never
  concatenated into one implicit digest.
- Long-running add-in waits SHOULD emit progress every 10 seconds.
- The bridge pauses data emission while the transport's buffered outbound data exceeds 8 MiB.
- Control messages and heartbeats MUST remain serviceable while result chunks are backpressured.
- O1-T6 evidence samples the active binding's actual `bufferedAmount` and retains a versioned bounded summary
  of high-water blocks, control frames sent while above high water, and per-invocation chunk/progress/terminal
  frame counts. These counters are evidence about observed transport behavior; they do not replace wire capture.
- The combined decoded bytes of the structured-result stream and every artifact stream are limited to 32 MiB
  per invocation. Larger results fail with `oversize`; Gateway-side result/artifact hygiene is a separate WP2
  layer and does not raise this wire limit.

### 13.1 GAP-7 RBP multi-file output carrier

RBP/1 does not add a general Gateway-to-workstation `file_fetch` message and does not define client upload,
`artifact_ref`, retention, or north-MCP resource behavior. Those are WP2 Gateway responsibilities in
`docs/implementation-plan/02-gateway-core.md`; actual Codex Desktop file/image behavior is a WP9 gate under
`docs/implementation-plan/00-INDEX.md` Section 4. O1 stubs may inject or consume bytes to test this carrier,
but that evidence MUST NOT mark a north-bound WP2/WP9 requirement passed.

Workstation-produced output, including a tool result containing multiple PNG/JPEG files, uses
`artifact_result_v1` as follows:

1. The signed registry contract declares each result field that may contain one artifact path or an ordered
   list of artifact paths. Export parameters target the bridge-managed spool root. For every returned path, the
   bridge canonicalizes it, requires a regular non-reparse file beneath that root, opens it without following
   links, and verifies size after open. An arbitrary add-in string is never readable. One invalid member fails
   the whole artifact conversion; valid siblings are not silently returned as a partial set. Validation and
   descriptor assignment for every member finish before the first artifact chunk is emitted.
2. The bridge walks declared fields and list members in deterministic field/input order, assigns contiguous
   `artifact_index` values from zero, and mints one `artifact_id` per file. It replaces every local path in the
   sanitized structured result with exactly `{artifact_id,artifact_index}`. No drive, directory, raw model
   path, or uncorrelated basename survives in that result.
3. Each file is one independent Section 13 chunk stream. Every chunk carries
   `stream_id:"artifact:<artifact_id>"`, the same `artifact_id`, the same `artifact_index`, and a per-stream
   `chunk_index` starting at zero. Interleaving streams is allowed; ordering within each stream and the
   invocation's ordinary `seq`/ack behavior remain authoritative.
4. The one terminal invocation `result` carries an `artifacts` array in `artifact_index` order. Every entry
   requires `{artifact_id,artifact_index,stream_id,filename,content_type,total_chunks,total_size,sha256}`.
   `filename` is a basename only. IDs and indices are unique, indices are contiguous, `stream_id` is exactly
   `artifact:<artifact_id>`, and count/size/digest values describe only that stream. A maximum of 16 artifact
   entries and the combined 32 MiB invocation limit apply. `chunked:true` and the sanitized `result` mapping
   are REQUIRED when `artifacts` is non-empty.
5. The Gateway RBP receiver verifies the sanitized-result mapping, descriptor uniqueness/contiguity, every
   reconstructed stream, and the combined limit before durably accepting the terminal carrier. What WP2 does
   with those verified bytes—and whether a north client can receive them—is outside RBP/1.
6. Local spool cleanup occurs only after durable acknowledgement of the terminal carrier or bounded expiry and
   is owned by the Bridge implementation. Retransmission/replay preserves artifact ids, indices, descriptors,
   stream ids, and bytes exactly. `artifacts` MUST be absent when `payload_omitted:true`; if retained artifact
   bytes cannot be replayed exactly, the ordinary omission/read-recovery contract applies and no stale
   descriptor claims a usable file.

One artifact chunk and the terminal two-file mapping therefore have these shapes:

```json
{
  "kind": "chunk",
  "invocation_id": "0197a3c2-0000-7000-8000-000000000010",
  "stream_id": "artifact:0197a3c2-0000-7000-8000-000000000201",
  "artifact_id": "0197a3c2-0000-7000-8000-000000000201",
  "artifact_index": 0,
  "chunk_index": 0,
  "encoding": "base64",
  "content_type": "application/octet-stream",
  "data": "UE5HMQ=="
}
```

```json
{
  "kind": "invocation",
  "invocation_id": "0197a3c2-0000-7000-8000-000000000010",
  "status": "completed",
  "result": {
    "files": [
      {"artifact_id":"0197a3c2-0000-7000-8000-000000000201","artifact_index":0},
      {"artifact_id":"0197a3c2-0000-7000-8000-000000000202","artifact_index":1}
    ]
  },
  "chunked": true,
  "artifacts": [
    {
      "artifact_id": "0197a3c2-0000-7000-8000-000000000201",
      "artifact_index": 0,
      "stream_id": "artifact:0197a3c2-0000-7000-8000-000000000201",
      "filename": "plan.bin",
      "content_type": "application/octet-stream",
      "total_chunks": 1,
      "total_size": 4,
      "sha256": "sha256:b8fc6f9ab4621d16761cbc0335bbd804b0ebcc3d1d2aa8c757687501adc51aaa"
    },
    {
      "artifact_id": "0197a3c2-0000-7000-8000-000000000202",
      "artifact_index": 1,
      "stream_id": "artifact:0197a3c2-0000-7000-8000-000000000202",
      "filename": "detail.bin",
      "content_type": "application/octet-stream",
      "total_chunks": 1,
      "total_size": 4,
      "sha256": "sha256:6811c03a4f0a72e5d984d9feb5f2f8b30135f1085340e99c32364e6b20f9d608"
    }
  ],
  "replayed": false,
  "payload_omitted": false,
  "late_after_indeterminate": false
}
```

This closes only the multi-file RBP output transport. It neither specifies nor proves client-origin upload,
Gateway resource authorization, image display/download, or DP-10 acceptance.

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
  "replayed": false,
  "late_after_indeterminate": false,
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
`verification_required` MUST be true. A `journal_indeterminate` invocation or nested batch error also requires
the affected `verification_hold_id` and `mutation_scope`. Retryability, outcome, and verification requirement
are explicit on every top-level or nested error; no parent status supplies them by implication.

`replayed` and `late_after_indeterminate` default to false. A known terminal error discovered after an earlier
indeterminate classification may be returned only on origin-key redelivery with both true plus
`verification_hold_id` and a required `result_digest` over the exact durable raw response/error evidence. It
follows Section 6.2.1 and does not clear the hold by itself.

The orchestrator, not the bridge, owns bounded retry policy. A write is never blindly retried: after the first
add-in byte may have been sent, transport timeout, process loss, cancellation uncertainty, or add-in
unreachability MUST be classified through the journal. If non-execution cannot be proved,
`journal_indeterminate` replaces the otherwise retryable environment class and activates the Section 6.2.1
scope hold.

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
| Artifact streams per invocation | 16 |
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
- RBP `status:"guarded"`, derived from an add-in `guarded:true` result and paired with the required
  `guarded_reason`, is protected product behavior and remains distinct from a failed operation.
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
28. Pending-expiry mutation installs the `(rsid,mutation_scope)` conflict hold; fresh-id invoke and batch writes
    are blocked; correlated read and late-terminal evidence exercise every retained/cleared transition and an
    invalid or inconclusive clearance never opens dispatch
29. Mixed terminal/non-terminal `atomic:false` batch redelivery plus atomic terminal replay/indeterminate
    recovery; every nested error carries explicit outcome/verification fields and affected scope holds
30. RFC 8785 `params_digest`, explicit per-step digest, and `batch_digest` golden vectors cover property order,
    number formatting, Unicode, escapes, step omission, params/digest mismatch, and changed policy/scope/clearance
31. `heartbeat_ack`, registration/unregistration/resume, cancel, goodbye, and manifest payload-schema positive/negative vectors
32. Chunk Base64 alphabet/padding, per-stream identity/indexing, decoded-byte limits, reconstruction size, and
    decoded-content digest
33. Loopback-only discovery/connect rejection for wildcard, LAN, hostname-resolved remote, and override targets
34. Session document-schema and seat/user spoof rejection against authenticated enrollment
35. Maximum-safe `seq` acceptance, unsafe `2^53` rejection, no-wrap renewal, duplicate, and gap behavior
36. WSS-primary and the exact Streamable HTTP/SSE create/events/messages lifecycle produce identical journal/resume outcomes, including opening-error and proxy-buffering vectors
37. Every `session_unregister` reason revokes resume, prevents new dispatch, and preserves a possibly dispatched mutation as indeterminate
38. `status:"guarded"` requires a valid `guarded_reason`; first-delivery `atomic:false` stops on that guarded step and marks all successors `not_started`
39. `payload_omitted` positive/negative vectors enforce replay-only use, required digest, absent result, and audited read-based recovery
40. GAP-7 RBP artifact vectors reject raw/local/traversal/reparse paths and prove multi-file
    `artifact_id`/`artifact_index` mapping, independent chunk streams, descriptor/digest/size verification,
    retransmission identity, and all-or-nothing invalid-member rejection; no north-client claim is made

The required pilot stack additionally runs a real-add-in smoke covering each method family, one confirm-class write, forced reconnect, and one atomic batch.

## 22. v1.0 semantic-freeze gate and deferred tag closure

The `1.0` candidate text closes the known semantic review items: primary/fallback lifecycle and opening failures,
zero-based backoff, version window, per-session capability/version fields, unregistration, guarded and omitted
result fields, first-delivery and redelivery batch behavior, session/scope mutation recovery holds, explicit
verification/late-evidence clearance, RFC 8785 invocation and batch digest inputs, complete nested errors, and
the multi-file RBP-side GAP-7 output carrier.

The document reaches **M1 semantic freeze** when one protected-PR candidate
contains all of the following evidence and is squash merged through the
protected `main` path:

- JSON Schemas under `packages/protocol/schemas/rbp/v1` cover every payload, conditional result/batch field,
  control/data envelope prohibition, and capability gate in this document; generated types are byte-stable.
- One complete Section 21 golden-vector/conformance suite is green on the exact
  current candidate and the protected PR check rollup is retained.
- The exact loopback fixture proves the required `mcp_status`/`get_document_context` version and per-session
  capability fields, loopback rejection, and `execute_batch` success/rollback wire behavior.
- The add-in implementation owner accepts the batchable-command restrictions
  and atomic rollback evidence. Barış Tankut recorded that acceptance on
  2026-07-25.
- GAP-7 RBP stub vectors prove the Section 13.1 multi-file output carrier, stream/descriptor integrity, spool
  confinement, acknowledgement/replay, and cleanup without a general RBP `file_fetch`. WP2/WP9 retain all
  client upload, `artifact_ref`, north-resource authorization, and display/download evidence.
- Gateway audit and bridge journal evidence materialize the exact RES-21 key, and the dated review outcome plus
  any normative R-F amendments are recorded in `docs/decisions/DP-log.md`.

Evidence is reported in four non-interchangeable tiers:

1. **Semantic/schema evidence:** this `1.0` candidate text, complete payload schemas, clean generated-type diff, and
   byte-exact golden vectors show that the proposed contract is internally expressible. They do not prove a
   running bridge, Gateway, journal, add-in fixture, or live Revit path and MUST NOT be reported as full M1.
2. **Executable M1 evidence:** O1-T3 add-in loopback fixture, O1-T4 bridge simulator, O1-T5 Gateway stub, and
   O1-T6 complete Section 21 suite must produce one full green current-candidate
   PR check rollup. Protected tree-equal merge of that candidate establishes
   the frozen RBP/1 contract and opens the M1 dependency for M2/M3. Absence of
   the tag does not reopen M1 or block those lanes.
3. **Deferred tag-closure evidence:** three consecutive complete retained
   Section 21 runs, one real one-hour reconnect/proxy-churn soak, WSS and exact
   Streamable HTTP/SSE proxy-interoperability parity against the same
   journal/resume fixtures, and protected candidate/tag identity validation.
   This evidence may be produced in parallel with M2/M3 and is non-blocking for
   their start. It is not a substitute for the M1 suite and it MUST be complete
   before `rbp/v1.0.0` is created.
4. **Pilot evidence:** O1-T7 exercises the adapted add-in on real Windows/Revit after protocol freeze; WP9
   separately proves the selected client. These are pilot-entry gates and cannot be substituted by schema,
   simulator, or fixture results.

If T3–T7 implementation evidence reveals that a required field, state
transition, digest, carrier, or safety rule cannot be implemented as written,
the owner MUST leave the affected gate red and record a dated R-F amendment
before changing the normative contract. Missing or incomplete deferred tag
evidence keeps only tag closure pending and does not retroactively reopen M1 or
block M2/M3. A substantive semantic or safety finding still follows R-F and
Section 7.3, and every gate it affects remains red. Evidence is repeated,
multiplied, or made blocking beyond the authoritative gate only with explicit
R-G operator authorization. Weakening a vector, adding an undocumented
tolerance, or calling a partial tier “passed” is not conformance.

The executable candidate carries the canonical `1.0` metadata and runtime
constant before the real evidence runs. That version identity is a byte under
test, not by itself a freeze verdict. The protected tree-equal M1 merge fixes
the semantic candidate. Only after the separate retained three-run aggregate,
one-hour soak, proxy-interoperability evidence, and protected-tree identity
checks pass may that exact protected candidate commit receive `rbp/v1.0.0`;
the later evidence-record-only protected PR records those facts without
changing the tagged candidate. A semantic finding before the tag follows the
dated R-F and Section 7.3 versioning rules; any required evidence repetition is
bounded by the applicable gate and R-H evidence ceiling. Any semantic change
after the tag also follows Section 7.3.

The real adapted-add-in smoke in Section 21 and WP9 hands-on DP-10 artifact/client evidence remain separate
pilot-entry gates after protocol freeze; they are not prerequisites for M1 semantic freeze or tag closure. They MUST validate
the frozen contract, and an incompatibility cannot be papered over: it requires the applicable additive
capability or protocol-version/R-F change before pilot use.

## Appendix A (normative): add-in loopback contract v1

This appendix closes the versioned contract needed by the O1-T3 add-in loopback fixture. It is an additive
contract for the adapted add-in; it does not implement the add-in, change the existing four-byte framing, or
make the Section 22 executable-evidence gate green. The machine-readable sources are:

- `packages/protocol/schemas/addin-loopback/v1/json-rpc-response.schema.json`
- `packages/protocol/schemas/addin-loopback/v1/mcp-status.schema.json`
- `packages/protocol/schemas/addin-loopback/v1/get-document-context.schema.json`
- `packages/protocol/schemas/addin-loopback/v1/execute-batch.schema.json`

The schemas and this appendix are one normative unit. A contradiction is a red O1-T3 result and requires a
spec/schema correction before freeze; an implementation MUST NOT add a tolerance locally.

### A.1 Binding, framing, and JSON-RPC envelope

The adapted add-in listener MUST bind only IP loopback endpoints. The bridge MUST reject a wildcard, LAN,
hostname-resolved non-loopback, or remote candidate before sending a JSON-RPC byte and MUST confirm the actual
listener addresses from `mcp_status.result.service.boundAddresses`. Both checks use the operating system's IP
loopback predicate; a string prefix check is insufficient. There is no production opt-out.

Every message is one UTF-8 JSON object preceded by an unsigned four-byte big-endian payload length. The v1
add-in request is exactly `{jsonrpc:"2.0",id,method,params}`. `id` is a non-empty string and is echoed exactly.
The bridge never sends a JSON-RPC batch array or the legacy unframed dialect.

A success is exactly `{jsonrpc:"2.0",id,result}` and every `result` object carries
`resultContractVersion:2`. An error is exactly `{jsonrpc:"2.0",id,error:{code,message,data?}}`; `id` is null
only when parsing did not recover a request id. A response cannot contain both `result` and `error`. Add-in
loopback v1 uses only the standard JSON-RPC codes `-32700`, `-32600`, `-32601`, `-32602`, and `-32603`.

### A.2 `mcp_status`: discovery and per-session capability authority

The request params are the empty object. The response preserves the existing `activeTask`, `recentTasks`,
history counters, and plan fields and adds these REQUIRED discovery fields:

| Field | v1 rule |
|---|---|
| `addinLoopbackContractVersion` | Integer `1`. It is independent of RBP/1 and `resultContractVersion`. |
| `addinVersion` | Exact installed product/build identity used in `session_register`. |
| `revit` | `{version,build,processId}` for this Revit process. |
| `service` | `{isRunning,port,binding:"loopback_only",boundAddresses:[...],framing:{...}}`; every address is IP loopback. |
| `sessionCapabilities` | Unique subset of `batch_atomic` and `doc_context_cached_v1`. |
| `capabilityContracts` | An identically keyed descriptor for every advertised capability and no descriptor for an unadvertised capability. |

Capability strings are claims about this one probed Revit session, not the bridge connection. The bridge MUST
copy only successfully probed claims into `session_register.session_capabilities`; the Gateway grant remains
the intersection returned in `session_registered.granted_session_capabilities`. A filename, add-in version,
Revit version, or another session's probe MUST NOT synthesize a capability.

`service.framing` is exactly
`{protocol:"length_prefixed_jsonrpc_v1",headerBytes:4,byteOrder:"big_endian",payloadEncoding:"utf-8",maxRequestPayloadBytes,maxResponsePayloadBytes:33554432}`.
`maxRequestPayloadBytes` is the listener's effective configured cap from 1 MiB through the existing absolute
128 MiB ceiling; the default is 16 MiB. Both limits count only the BOM-free UTF-8 JSON payload bytes, excluding
the four-byte header. The header is the exact unsigned big-endian payload-byte count. The bridge MUST serialize
and byte-count before writing and MUST NOT send a payload above the probed request cap. The add-in independently
rejects an advertised-cap-plus-one request from its header, returns correlated-id-unavailable `-32600`, and
closes that socket without JSON parsing or dispatch. An oversized response frame is never emitted. For an
ordinary mutating command whose handler has already committed, a bounded correlated `-32603` substituted by
the framing layer is **not** known-failure evidence: the bridge maps it to `indeterminate` with verification
required. `execute_batch` instead uses the pre-assimilation rule in Appendix A.4 so a size failure can roll
back cleanly. O1-T3 retains exact max and max-plus-one request/response vectors, including multibyte UTF-8
input, and counts the header separately.

`doc_context_cached_v1` has the exact descriptor
`{contractVersion:1,method:"get_document_context",source:"application_events_cache",pollIntervalMs:15000,uiThreadRoundTrip:false}`.
It may be advertised only when the command returns the Appendix A.3 contract from an application-event-backed
cache without raising an ExternalEvent.

`batch_atomic` has these REQUIRED descriptor fields:

| Field | Required value/meaning |
|---|---|
| `contractVersion` | `1` |
| `method` | `execute_batch` |
| `maxSteps` | Runtime limit from 1 through 64; the bridge uses the lower of this and its own limit. |
| `maxRequestPayloadBytes` | Aggregate BOM-free UTF-8 JSON-RPC request cap; equals `service.framing.maxRequestPayloadBytes`. |
| `maxResponsePayloadBytes` | Aggregate BOM-free UTF-8 JSON-RPC response cap; equals `service.framing.maxResponsePayloadBytes` (`33554432`). |
| `transactionBoundary` | `revit_transaction_group` |
| `rollbackPolicy` | `rollback_on_non_success` |
| `batchableCommands` | The exact session-local executable subset, with one unique descriptor per method. |

Every command descriptor also carries `resultDelivery:"inline_only"` and
`maxInlineResultBytes:8388608`; together they attest before dispatch that the command never requires RBP
chunk/artifact delivery and that its canonical result stays within 8 MiB when nested in a batch. For
`atomic:false`, the bridge reserves bounded wrapper/error/not-started overhead, accounts the actual canonical
result bytes after each step, and lowers the next step's allowed inline bytes to the remaining negotiated
aggregate budget. It does not sum theoretical per-step maxima into an artificial batch-length limit. A
post-dispatch per-step or remaining-aggregate cap violation uses the delivery-fault/effect-state rule in
Section 11.1 and stops all successors. For `atomic:true`, Appendix A.4 enforces both per-step and tentative
aggregate limits before `TransactionGroup.Assimilate()`.

Each `batchableCommands[]` descriptor is
`{method,effect,transactionPolicy,rollbackDisposition,parameterProfile,resultDelivery,maxInlineResultBytes}`
with REQUIRED `resultDelivery:"inline_only"` and `maxInlineResultBytes:8388608`. The hard v1 eligible set is:

```text
get_current_view_elements, get_current_view_info, get_selected_elements, list_open_views,
get_ui_state, find_elements, inspect_levels, inspect_sheet_text, inspect_schedules,
count_annotations, extract_spatial_snapshot, get_spatial_change_state, delete_review_view
```

The read methods use
`effect:"read_only"`, `transactionPolicy:"none"`,
`rollbackDisposition:"discard_result_on_batch_rollback"`, and `parameterProfile:"ordinary_v1"`.
`delete_review_view` uses
`effect:"model_transaction"`, `transactionPolicy:"nested_transaction_required"`,
`rollbackDisposition:"transaction_group_rollback"`, and
`parameterProfile:"delete_review_view_commit_v1"`. Advertising `batch_atomic` requires this exact
`delete_review_view` descriptor; a read-only fan-out is not evidence of atomic mutation support. Raw
`send_code_to_revit` is never batchable: a Revit `TransactionGroup` cannot roll back arbitrary filesystem,
process, network, static-state, or UI side effects from dynamic code.

The status array MAY advertise a smaller subset when a command assembly is absent, but `execute_batch` MUST
reject a step not present in that exact array before opening a `TransactionGroup`. The following methods are
unconditionally non-batchable in v1: `mcp_status`, `get_document_context`, `execute_batch`,
`send_code_to_revit`, `activate_view`, `close_view`, `clear_selection`, `open_existing_plan_for_element_level`,
`focus_elements`, `section_box_elements`, and `create_3d_view_for_elements`. This closes recursive dispatch and
UI/view-state side effects whose rollback is not equivalent to a model `TransactionGroup` rollback. Adding an
eligible method changes the add-in loopback contract version; it is not an undocumented within-v1 tolerance.

`mcp_status` remains a discovery/heartbeat/failure-diagnostic method. It MUST NOT return to the normal invoke
hot path as a per-command preflight.

### A.3 `get_document_context`: cached snapshot

The request params are the empty object. Its success result contains exactly:

```text
resultContractVersion: 2
documentContextContractVersion: 1
capturedAtUtc: RFC 3339 timestamp
revision: non-negative JSON-safe integer
cacheState: ready | warming | unavailable
unavailableReason: null for ready, otherwise a bounded non-empty reason
documents: [{documentId,title,pathDigest,isWorkshared,isActive}, ...]
activeDocumentId: string | null
activeView: {documentId,id,name,type,level:string|null} | null
disciplineHint: bounded token | null
```

`revision` increases monotonically within the Revit process whenever the normalized snapshot changes.
`documentId` is stable only for that local add-in session. `pathDigest` is null or lowercase SHA-256 with the
`sha256:` prefix; a raw model path is never present. A ready snapshot has at most one `isActive:true` document.
When `activeDocumentId` is non-null, it MUST equal that document's `documentId`; a non-null
`activeView.documentId` MUST equal that same `activeDocumentId`. When there is no active document,
`activeView` is null. `warming` and `unavailable` carry no
documents or active view. These cross-field rules are semantic fixture assertions in addition to JSON Schema.

The bridge polls this command at the Section 14 cadence and maps camelCase add-in fields to the RBP
`doc_context_update` snake_case fields. It MUST NOT substitute `get_current_view_info` plus `list_open_views`
for a missing or invalid capability.

### A.4 `execute_batch`: one atomic add-in dispatch

`execute_batch` exists only for RBP `invoke_batch` with `atomic:true` and a granted `batch_atomic` capability.
The outer JSON-RPC `id` MUST equal `params.batchId`. Params contain exactly
`batchContractVersion:1`, `batchId`, `batchDigest`, `atomic:true`,
`rollbackPolicy:"rollback_on_non_success"`, `maxAggregateResultBytes`, and ordered `steps`.
`maxAggregateResultBytes` MUST equal the connection-negotiated RBP `max_result_bytes` and is the authoritative
aggregate BOM-free UTF-8 JSON-RPC response cap for this dispatch.

Each step contains `{index,invocationId,method,params,paramsDigest,effect}`. Indices are contiguous from zero,
invocation ids are unique, and each method/effect pair MUST match the descriptor in the most recent successful
probe for that session. The digests are copied for correlation with the already-verified RBP request; they do
not replace raw params and do not move Section 12.1 digest authority into the add-in. The only v1 mutation
profile is `delete_review_view_commit_v1`: `params` requires `mode:"commit"`, `confirmDelete:true`, and
exactly one bounded selector (`viewId`, or a `viewName` with `exactName:true`); optional `viewType` is exactly
`ThreeD`, including when the selector is `viewId`. Ordinary v1 method params stay open to additive
method-specific fields, but the following exact reserved-name set is rejected before dispatch:
`target`, `host`, `port`, `timeoutMs`, `statusRefreshTimeoutMs`, `refreshStatusAfterCommand`, `responseMode`,
`transactionMode`, `parseJsonResult`, `taskName`, `taskId`, `wrapperAction`, `logicalToolName`, `toolName`,
`parentTaskName`, `parentTaskId`, `suppressTaskStatusWindow`, `display`, `invocation_id`, `batch_id`,
`batch_digest`, `params_digest`, `mutating`, `mutation_scope`, `policy`, `verification`,
`recovery_clearances`, `timeout_ms`, `batchContractVersion`, `batchId`, `batchDigest`, `invocationId`,
`paramsDigest`, `effect`, `atomic`, `rollbackPolicy`, `maxAggregateResultBytes`. These are connection, timeout, response-mode,
display/audit, RBP, or add-in batch-control fields; rejecting these exact names MUST NOT close the params
object to future functional tool parameters. The batch handler invokes the extracted command seam directly
on the current Revit API thread; it MUST NOT raise or wait for a nested `ExternalEvent`.

The add-in validates the complete request before Revit execution, then raises exactly one ExternalEvent. On
the Revit API thread it opens one `TransactionGroup`, executes the advertised command seams directly in input
order, and never raises/waits for a nested ExternalEvent. After each normalized step result, it constructs the
exact tentative success envelope for that prefix plus the minimal `not_started` suffix and counts the entire
BOM-free UTF-8 JSON-RPC payload. Before making that projection, each completed step result MUST satisfy its
advertised `resultDelivery:"inline_only"` and `maxInlineResultBytes:8388608`; artifact-shaped or oversized
step output becomes `invalid_result` and triggers rollback without exposing the raw result. If the projection
exceeds `maxAggregateResultBytes`, that current step becomes
`failed` with `error.code:"response_payload_limit"`, the measured cap and tentative byte count, and the group
rolls back before `Assimilate()`. Only an all-success envelope at or below the cap may assimilate. The first
guarded result, other failure-shaped result, or exception likewise stops execution and rolls the whole group
back; every successor is `not_started`.

The success-envelope result contains
`{resultContractVersion,batchContractVersion,batchId,batchDigest,atomic,status,transactionState,failedStepIndex,steps,rollback}`.
The exact terminal matrix is:

| `status` | `transactionState` | `failedStepIndex` | `rollback` |
|---|---|---|---|
| `completed` | `committed` | null | `{attempted:false,succeeded:null,triggerStepIndex:null,triggerState:null}` |
| `guarded` | `rolled_back` | first guarded index | `{attempted:true,succeeded:true,triggerStepIndex:<same>,triggerState:"guarded"}` |
| `failed` | `rolled_back` | first failed index | `{attempted:true,succeeded:true,triggerStepIndex:<same>,triggerState:"failed"}` |
| `indeterminate` | `indeterminate` | first non-success / rollback-trigger index | `{attempted:true,succeeded:false,triggerStepIndex:<same>,triggerState:"guarded"|"failed"|"indeterminate",error:{code:"rollback_failure",message}}` |

Every response step repeats `index`, `invocationId`, and `method` and adds `executionState` plus `effectState`.
On commit, a read has `effectState:"read_only"`, a mutation has `effectState:"committed"`, and each carries its
result. On rollback, a previously completed/guarded/failed model mutation has `effectState:"rolled_back"`; a
read result obtained inside the transient group has `effectState:"discarded"`. Neither is exposed: the step
omits `result` and carries `resultSuppressed:"batch_rolled_back"`. Successors use
`executionState/effectState:"not_started"` and have no result, error, guard, or suppression field. A guarded
step has a normalized `guardedReason`; a failed or indeterminate step has bounded structured `error` data.
`response_payload_limit` additionally carries `maxResponsePayloadBytes:<maxAggregateResultBytes>` and
`tentativeResponsePayloadBytes > maxResponsePayloadBytes`; it is a clean failed-step rollback when
`rollback.succeeded:true`, never a post-commit synthetic failure.
If rollback itself fails, every possibly executed mutation uses `effectState:"indeterminate"`, every read
uses `effectState:"discarded"`, and both use `resultSuppressed:"batch_indeterminate"`; no step may retain a
`committed`, `rolled_back`, or visible-result claim. `rollback.triggerState` equals the triggering step's
`executionState`. The `rollback_failure` code is reserved exclusively for
`status:"indeterminate"` / `rollback.succeeded:false` at `rollback.error`; it MUST NOT appear in any step's
`error` object or in a clean `failed` / `rolled_back` carrier.

Parse, shape, unsupported-method, descriptor-mismatch, and parameter-profile failures detected before the
group opens use a JSON-RPC error response and execute zero steps. Once the group opens, the add-in returns the
batch success-envelope result even for a clean guarded/failed rollback. A reported rollback failure is
`indeterminate`; loss of the socket/process before a valid terminal response is independently promoted by the
bridge to the Section 11/12 indeterminate path. Transport success is never commit evidence.

The bridge verifies request/response batch id, digest, step count, contiguous indices, invocation ids, methods,
failure index, rollback trigger, and prefix/suffix state machine before journaling a terminal RBP batch. It maps
only `completed/committed` to committed RBP effects. A malformed or contradictory response cannot be repaired
by inference and becomes an indeterminate dispatched batch.

### A.5 Fixture and evidence boundary

The positive and negative JSON fixtures under `packages/protocol/fixtures/addin-loopback/v1`, together with
the exact aggregate max/max-plus-one byte tests, are golden schema/semantic vectors. They prove the shapes,
correlation/rollback invariants, and serialization boundaries without Revit. They do
not prove framing behavior, a listener binding, an ExternalEvent, a `TransactionGroup`, crash behavior, or a
real rollback. Those remain O1-T3 and O1-T7 executable gates under Sections 21 and 22.

The executable O1 fixtures additionally expose bounded versioned snapshots for conformance correlation:
document-context cache update/read/poll counters with a zero-valued ExternalEvent counter and monotonic event
ordering; a Gateway authorization trail containing only decision metadata, hashed connection/device identity,
and claimed-field names; and Bridge retained-carrier descriptors that redact every spool/local path and are
rehydrated through the ordinary containment, non-reparse, size, and digest guards. A snapshot overflow is
reported through explicit dropped counts or fails closed at the artifact-carrier inspection bound.
