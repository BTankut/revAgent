# revAgent Gateway Remediation Decision Freeze

Status: RECOVERED CONTROL PLANE / DESIGN-FROZEN / NOT ACCEPTED
Control-plane authority: local operator-approved orchestration state
Canonical path:
.orchestration/DECISION_FREEZE.md

This file is the first recovered authoritative local Decision Freeze instance.
The original orchestration bundle required WP-01 to create this file but did not
ship a pre-populated copy. This record does not claim to be a byte-for-byte
reconstruction of a missing historical file.

Historical BLOCKED evidence remains immutable and is not superseded by this
control-plane recovery.

## Programme state

Protected main:
4b194ab759f76618ac1143fa75ac7b13f14763e6

Remote WP-12 PR head:
ef2b2b4f298d888b23818ef57d18137f6daa1fad

Current local WP-12 candidate:
7f08633e3e57d65d09401db96e35b8b62a9af2af

Candidate tree:
5bf9c834166833827d7ec374d6999cb4a192d50f

PR #397:
OPEN / DRAFT / UNMERGED

WP-12:
REWORK / BLOCKED_SCOPE / NOT ACCEPTED

WP-13:
LOCKED / NOT STARTED

M4:
IN_PROGRESS / NOT ACCEPTED

## Amendment WP12-C39-ROUTE-REBIND-V1

Decision:
APPROVED FOR IMPLEMENTATION AND VERIFICATION ONLY

This amendment changes the normative O1 state semantics while preserving the
existing RBP message set and data-sequence rules.

### Root cause

After restart, a retained terminal owns reserved data sequence N while the peer
ACK is N-1. Gateway correctly requires current-connection document-route
authorization before accepting the replayed terminal.

A normal route update would consume N+1 and cannot legally pass the unresolved
N fence. Accepting N without current-route proof would weaken stale-route and
cross-connection substitution defenses.

The deadlock is production-reproduced and is not a harness-only failure.

### Approved design

No new RBP message type is introduced.

The existing unsequenced `session_resume` control payload receives one
capability-gated optional proof:

- capability: `route_rebind_proof_v1`
- payload member: `route_rebind_proof`
- proof version: v1

The proof binds the resume to:

- the current CSPRNG `hello_ack.connection_id`,
- fresh document context,
- the current cache incarnation identity,
- the current cache/document revision evidence,
- the existing owner-bound RSID and resume authority.

Gateway validates and records the proof atomically inside the existing resume
CAS before emitting `resume_ack`.

The proof consumes no RBP data sequence.

After the resume CAS succeeds, the retained terminal at sequence N may be
evaluated against the newly established current-generation route authority
without requiring an N+1 document-route message to overtake it.

### Preserved invariants

`route_rebind_proof_v1`:

- is not an actor credential,
- is not MCP-session authority,
- is not principal authority,
- is not recovery authorization by itself,
- does not replace tenant/user/seat/device checks,
- does not replace effective MCP-session checks,
- does not replace session-binding/version checks,
- does not weaken current-connection or current-generation checks,
- does not authorize cross-principal, cross-session, cross-binding, or
  cross-RSID recovery,
- does not execute or replay the origin invocation,
- does not clear a verification hold,
- does not reorder or skip data sequence numbers,
- does not permit N+1 to overtake N,
- does not trust stale pre-restart route state.

Invalid, stale, absent, mismatched, replayed-from-an-old-connection, or
capability-ungranted proof fails closed.

### Capability and compatibility

The extension is capability-gated.

A peer without `route_rebind_proof_v1` continues to use the previous
`session_resume` shape.

Absence of the capability must not silently weaken route authorization. The C39
pre-peer restart recovery path remains unavailable or guarded for that peer.

Unknown optional fields remain compatible with the existing RBP/1 parsing rule,
but the new semantic is active only when the capability has been mutually
negotiated and granted.

No protocol-version claim or milestone acceptance is created by this amendment.

### Exact additional write scope

The existing WP-12 write scope remains active.

The following nine paths are added and no broader `packages/protocol/**` or
`docs/**` permission is granted:

1. packages/protocol/schemas/addin-loopback/v1/get-document-context.schema.json
2. packages/protocol/tests/addinLoopbackSchemas.test.ts
3. packages/protocol/schemas/rbp/v1/payloads.schema.json
4. packages/protocol/src/generated/envelope.ts
5. packages/protocol/src/generated/schema.ts
6. packages/protocol/conformance/fixtures/envelopes.json
7. docs/specs/O1-bridge-gateway-protocol.md
8. docs/implementation-plan/01-protocol-O1.md
9. docs/plan/M1_O1_FREEZE_EVIDENCE.md

No other protocol or documentation path is authorized.

Generated files must be produced by the canonical protocol generator. They must
not be manually edited. If canonical generation changes any additional path,
implementation stops at a new exact-scope gate.

### Design-package provenance

Design package:
.orchestration/artifacts/WP-12/recovery-incident-audit/
20260826T073324Z-c39-route-rebind-protocol-design.md

Design-package SHA-256:
7415b3d8ccf100a80bb65ed006c03605041182afb77fbe5f851b021392eece75

Handoff:
.orchestration/artifacts/WP-12/recovery-incident-audit/
20260826T073324Z-c39-route-rebind-design-handoff.json

Handoff SHA-256:
57fe18246d949d28712d86f82e2df40b79f8ead274a0052c4d83840282fc3320

Protocol fallback review:
FINAL APPROVE

Security fallback review:
FINAL APPROVE

Scope mapper:
APPROVE

The unavailable fixed-model custom roles performed no operation. Their startup
failure does not constitute review evidence. The recorded independent fallback
reviews are the design-stage review evidence.

### Required implementation tests

At minimum:

- capability absent,
- capability offered but not granted,
- valid proof,
- malformed proof,
- missing proof,
- stale connection id,
- old-generation proof replay,
- cache-incarnation mismatch,
- document-revision mismatch,
- RSID mismatch,
- principal mismatch,
- effective MCP-session mismatch,
- session-binding mismatch,
- duplicate resume,
- concurrent resume CAS,
- resume before retained terminal replay,
- restart before peer ACK,
- repeated byte-identical RestartResend,
- ACK loss,
- terminal N with peer ACK N-1,
- no N+1 overtaking,
- WSS C39,
- Streamable HTTP/SSE C39,
- C38 WSS regression,
- C38 HTTP/SSE regression,
- C29 regression,
- C28 regression,
- generated-schema drift check,
- full protocol conformance,
- Bridge restore/build/test,
- Gateway typecheck and lint.

### Acceptance rule

Implementation does not close WP-12 by itself.

WP-12 remains NOT ACCEPTED until:

1. every required targeted and full gate is green,
2. C39 is green on WSS and Streamable HTTP/SSE,
3. C38, C29, and C28 regressions are green,
4. exact generated sources match schemas,
5. independent integration review passes,
6. independent security review passes,
7. an exact reviewed SHA is recorded,
8. remote fast-forward and GitHub checks are independently read back,
9. PR #397 merge receives a separate operator approval.

### Rollback

Implementation base and rollback anchor:
7f08633e3e57d65d09401db96e35b8b62a9af2af

Rollback is append-only:

- revert the amendment implementation with a new commit,
- regenerate the previous protocol artifacts,
- rerun the previous C38/C39 baseline gates,
- do not reset, rebase, squash, or rewrite history.

No durable data migration may be introduced without a separate migration and
rollback gate.

### Prohibitions

Until a later explicit operator gate:

- no PR-ready transition,
- no PR merge,
- no main modification,
- no auto-merge,
- no squash,
- no rebase,
- no force-push,
- no history rewrite,
- no WP-13,
- no live Revit,
- no RVT open/write/save/synchronize,
- no device revoke,
- no deployment,
- no release,
- no signing,
- no NAS publish.

## Operator authorization

The operator approves Amendment WP12-C39-ROUTE-REBIND-V1 for implementation and
verification within the exact paths and invariants above.

This approval does not accept WP-12, M4, a PR merge, a deployment, or a live
Revit operation.
