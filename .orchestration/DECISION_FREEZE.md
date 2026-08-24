# WP-12 Decision Freeze

Status: DESIGN-FROZEN / NOT ACCEPTED

Base and rollback: `252234c321ddc395da6dae356f0dda32070c9f86`.

- Existing RBP wire schema is unchanged.
- better-sqlite3 is `13.0.3` only; `13.0.1` is prohibited. Existing gitHead/SRI and C38 evidence remain authoritative.
- C38 is green for WSS and HTTP/SSE at the approved base. WP-12 remains unaccepted.

Immutable better-sqlite3 provenance: version `13.0.3`; gitHead `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`; registered SRI `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`. Version `13.0.1` is prohibited. Its approved rollback remains `adce556a6b700e75d5fd464ad4ac65ba3bd0932e`.

## C39 production semantic extension

Add only an authority-owned, entitled, non-mutating `dispatch_payload_recovery` path for correlated omitted-payload retrieval. Observation/provenance may be fixture-only; recovery semantics and enforcement are production implementation.

Authorization is revalidated before and after bounded lookup against the same authenticated principal (`tenant_id` + `user_id`), effective MCP session, current Bridge binding, and owner-bound RSID. Require exact origin UUIDv7 and the existing raw-response `result_digest`; mismatch and absent/legacy/partial/corrupt/nonterminal/over-cap records have indistinguishable denial. The operation is idempotent and linearizable via a versioned CAS; retries for the same origin/digest return the same completion.

The C# side exposes only an exact, bounded, read-only journal lookup. A newly eligible terminal stores immutable exact UTF-8 response-body bytes (frame prefix excluded), typed digest-domain metadata, and owner/retention metadata in a v7 DPAPI-protected envelope. Enforce per-record and per-RSID 32 MiB caps, no logs, and parent retention/pruning. Gateway returns a same-scope `result_ref` bound to distinct origin UUID + origin digest, current scope/binding, and TTL no longer than remaining retention; reads reauthorize.

Prohibited: origin execution, generic replay, admin/private-store mutation, hold clearance, schema changes, fixture-only recovery, or any live Revit/device-revoke operation. Offline pre-v7 database restore to the rollback SHA is the rollback path.

## Exit gates

C39 WSS + HTTP/SSE adversarial gates, including authorization, digest/origin binding, idempotency/CAS, restart/retention, cap, and indistinguishable-denial cases, must be green. C29 and C28 remain locked until C39 is green. WP-12 cannot be accepted without these gates and independent security review PASS_PLAN.

Architecture review: PASS_PLAN required/recorded for this freeze. Security review: PASS_PLAN required/recorded for this freeze.

## Append-only C39 scope amendment

Amendment base and rollback: `252234c321ddc395da6dae356f0dda32070c9f86`. C38 is green WSS+HTTP; C39 is required and not yet green. C29/C28 remain locked, WP-12 is not accepted, and M4 is never accepted.

## C39-C raw-carrier clarification

C39-C uses a distinct internal recovery-carrier terminal/activation path and never calls the existing C38 inline-JSON activation. Existing RBP partial/chunk/terminal schema remains unchanged, including the existing allowed `application/json` content type; no enum, value, or schema addition is permitted. Reachability exists only for a durable pre-admitted recovery invocation internally bound to the exact owner tuple, origin UUID, and expected digest.

C# is a raw-only owned-byte producer: exact UTF-8 response bytes, at most 32 MiB total and 1 MiB per chunk, with origin digest verification before chunking. It must not parse, base64-wrap the whole payload, log, touch the add-in, or execute/replay the origin. The carrier plan, terminal, and resume cursor are durably journaled before any chunk ACK; each ACK remains Bridge+resource durable, and restart resends only the recovery stream.

Gateway private staging enforces ordered unique indexes with no gap/duplicate, exact length/digest/terminal checks, and maps recovery invocation to origin without new wire fields. It rechecks scope/binding after the stream and mints only a scoped `result_ref` with distinct reference digest and bounded TTL; no partial or reference leakage. The C38 path is unchanged. Required gates: WSS, HTTP/SSE, restart, backpressure, adversarial recovery, and C38 regression.

### C39-C1 protected-carrier refinement

Recovery must not use the C38 plaintext artifact spool or persisted base64/prefix frames; standard C38 is unchanged. The v7 internal recovery plan stores only DPAPI-authenticated metadata: version/domain, recovery invocation, full owner tuple (tenant/user/effective MCP session/sessionBinding/version/RSID), raw-row identity, origin UUID/digest, `application/json`, byte length (<=32 MiB), chunk geometry (<=1 MiB), terminal digest, plan version/cursor/expiry. It stores no bytes, frame data, or logs.

Persist plan and terminal before first send. Rehydrate protected raw bytes, rehash and strict-validate, then produce one deterministic chunk at the cursor; base64 exists only in memory/on the wire and is zeroed. Advance the cursor only on an exact authenticated durable Gateway ACK CAS; a lost ACK resends the same chunk and never the origin. Gateway staging deduplicates invocation+index+digest; corruption or expiry invalidates staging and yields no reference. Retain raw/plan until durable Gateway completion and result-ref retention permit pruning; disconnect keeps retry. Mandatory tests cover crash, ACK loss/CAS, tamper, no-plaintext, WSS, HTTP/SSE, and C38 regression.

### Authority boundary

The full owner-tuple binding is cross-component, not C# authority. Gateway alone atomically stores and reauthorizes tenant+user+effective MCP session+sessionBinding/version+RSID and maps that binding to recoveryInvocationId, origin UUID, and digest. Public MCP parameters remain exactly origin UUID plus expected digest.

C# protected source plans must not accept or infer owner identity. They bind only recoveryInvocationId, RSID, origin UUID/digest, raw-row identity, geometry, expiry, and version. An existing authenticated private correlation/receipt slot may contain only a Gateway-minted versioned keyed opaque admission MAC; it is never caller input, C# opaque/non-authoritative/unlogged, and exact-echo only. If no existing slot exists, add none; Gateway correlation by recoveryInvocationId plus durable admission is required. No owner identity or new wire field. Missing, mismatch, or expiry is uniform denial; Gateway freshly reauthorizes on resume, post-stream, and read. Tests cover caller override, cross-owner substitution, and no-wire fallback.

### No-wire sequence fence

Recovery uses the existing global outbound sequence allocator, with no generic outbox, raw store, or base64 persistence. Atomically reserve one non-skippable sequence for the current cursor; the lowest-unacked scheduler blocks later generic traffic. DPAPI metadata includes immutable nonraw header template/material (ids/correlation/fixed timestamp/sequence/historical ACK baseline/`application/json`/encoding/chunk geometry/terminal fields), canonical envelope digest, send-started/high-water, plan version, and expiry. A frozen serializer reconstructs byte-identical envelopes from verified protected raw bytes. Persist and read back the fence before writing.

ACK below the fence is no progress; exact current sequence after durable Gateway staging advances the CAS; above-current or unsent is a protocol fault. Lost ACK or restart resends exact sequence and bytes. The fence cannot expire, cancel, or recycle; raw and plan remain pinned through ACK and Gateway completion. Owner/session/binding/route loss with an unacked fence permanently tombstones the RSID route/sequence space, invalidates Gateway staging, blocks generic sends, requires a new RSID, and retains authenticated audit metadata. Final reference still requires full digest and reauthorization. Required tests cover crash/readback, ACK classes, tombstone, generic ordering, and serializer identity. C38 and wire schema remain unchanged.

### Migration-version clarification

Reviewed C39 raw-response retention remains contiguous v7. The protected source-backed recovery carrier plan and sequence-fence metadata are a separate contiguous v8 migration; the earlier v7 plan wording is superseded by this clarification. Existing and intermediate valid v7 records upgrade transactionally and idempotently. Partial, missing, or corrupt v7/v8 records fail closed. v6-to-v8 creates or reuses an immutable pre-v7 backup; v7-to-v8 never overwrites it. Rollback to SHA252/base uses offline v6 restore and rejects v7/v8 in-place. Required tests cover v6-to-v8, v7-to-v8, reopen/idempotency, partial-v8 denial, and rollback. Wire, C38, authority, and locks are unchanged.
