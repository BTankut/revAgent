# WP-12 Decision Freeze

Status: DESIGN-FROZEN / NOT ACCEPTED

Base and rollback: `252234c321ddc395da6dae356f0dda32070c9f86`.

- Existing RBP wire schema is unchanged.
- better-sqlite3 is `13.0.3` only; `13.0.1` is prohibited. Existing gitHead/SRI and C38 evidence remain authoritative.
- C38 is green for WSS and HTTP/SSE at the approved base. WP-12 remains unaccepted.

## C39 production semantic extension

Add only an authority-owned, entitled, non-mutating `dispatch_payload_recovery` path for correlated omitted-payload retrieval. Observation/provenance may be fixture-only; recovery semantics and enforcement are production implementation.

Authorization is revalidated before and after bounded lookup against the same authenticated principal (`tenant_id` + `user_id`), effective MCP session, current Bridge binding, and owner-bound RSID. Require exact origin UUIDv7 and the existing raw-response `result_digest`; mismatch and absent/legacy/partial/corrupt/nonterminal/over-cap records have indistinguishable denial. The operation is idempotent and linearizable via a versioned CAS; retries for the same origin/digest return the same completion.

The C# side exposes only an exact, bounded, read-only journal lookup. A newly eligible terminal stores immutable exact UTF-8 response-body bytes (frame prefix excluded), typed digest-domain metadata, and owner/retention metadata in a v7 DPAPI-protected envelope. Enforce per-record and per-RSID 32 MiB caps, no logs, and parent retention/pruning. Gateway returns a same-scope `result_ref` bound to distinct origin UUID + origin digest, current scope/binding, and TTL no longer than remaining retention; reads reauthorize.

Prohibited: origin execution, generic replay, admin/private-store mutation, hold clearance, schema changes, fixture-only recovery, or any live Revit/device-revoke operation. Offline pre-v7 database restore to the rollback SHA is the rollback path.

## Exit gates

C39 WSS + HTTP/SSE adversarial gates, including authorization, digest/origin binding, idempotency/CAS, restart/retention, cap, and indistinguishable-denial cases, must be green. C29 and C28 remain locked until C39 is green. WP-12 cannot be accepted without these gates and independent security review PASS_PLAN.

Architecture review: PASS_PLAN required/recorded for this freeze. Security review: PASS_PLAN required/recorded for this freeze.
