# M1 O1/RBP v1.0 Freeze Evidence

**Document state:** evidence ledger in progress; not a freeze decision

**Protocol candidate:** `1.0-rc.1`

**Milestone:** M1

**Tag state:** `rbp/v1.0.0` MUST NOT be created while any required row below is not `passed`

This ledger closes O1-T8 only after the executable O1-T3–T6 artifacts and every
M1 item in `docs/specs/O1-bridge-gateway-protocol.md` Section 22 are linked to
one exact source tree. A schema result, unit-test count, draft PR, or a passing
subset of the forty cases cannot substitute for the retained three-process
suite. O1-T7 real-add-in and DP-10 client evidence remain separate pilot-entry
gates after the protocol freeze.

## Freeze identity

The evidence-closing change must replace every `not_yet_available` field below
with a real value. The three conformance runs, one-hour soak, merge commit, and
annotated tag must resolve to the same Git tree.

| Identity | Required value | Current evidence | State |
|---|---|---|---|
| Candidate commit | Full 40-character Git commit SHA on protected `main` | `not_yet_available` | `in_progress` |
| Candidate tree | Full 40-character `git rev-parse <commit>^{tree}` value | `not_yet_available` | `in_progress` |
| Aggregate-bound source | Exact commit/tree repeated by all three run reports | `not_yet_available` | `in_progress` |
| One-hour-soak source | Exact same commit/tree as the aggregate | `not_yet_available` | `in_progress` |
| Freeze tag | Annotated `rbp/v1.0.0`, created only after protected-main tree equality is rechecked | Not created | `not_started` |

Tagging procedure after every row is green:

```text
git fetch origin main --tags
git rev-parse origin/main^{tree}
git rev-parse <evidence-closing-commit>^{tree}
git tag -a rbp/v1.0.0 <evidence-closing-commit> -m "Freeze O1/RBP v1.0"
git push origin rbp/v1.0.0
```

The two tree outputs must be byte-identical before the tag command. A branch
head, unmerged commit, dirty tree, or retargeted `main` invalidates the tag
procedure and requires a fresh evidence run.

## O1 work-item evidence

| Item | Required executable evidence | Current evidence | State |
|---|---|---|---|
| O1-T1 | Complete protocol schemas, generated types, and generate-then-clean-diff gate | Protocol package and CI gate merged; exact freeze-tree run to be linked | `in_progress` |
| O1-T2 | Shared FSM/digest/sequence/hold implementation consumed by T4/T5 | PR #282 merged; exact freeze-tree test report to be linked | `passed` |
| O1-T3 | Separate add-in loopback fixture process with framing, capability, fault, count, batch, and artifact evidence | PRs #283–#285 merged; exact process identity and suite evidence to be linked by T6 | `passed` |
| O1-T4 | Separate Bridge simulator process with both bindings, durable journal/holds, recovery, and artifact spool | PR #287 merged; 195/195 package tests and full local gates passed before merge; T6 process identity remains pending | `passed` |
| O1-T5 | Separate Gateway stub process with both bindings, auth/session tables, dispatch, resume, proxy/fault controls, and artifact sink | PR #286 merged; 70/70 package tests passed before merge; T6 process identity remains pending | `passed` |
| O1-T6 | Forty canonical cases × two bindings, three consecutive passing runs, retained JSON/JUnit, suite under ten minutes, zero fd/journal/orphan leak and bounded memory | Complete supervised suite not yet available | `in_progress` |
| O1-T8 | Harness findings folded into the candidate; metadata `1.0 / Frozen`; protocol constant; this ledger; protected-main tag | Blocked by O1-T6 and soak | `not_started` |

## Three-run conformance aggregate

Every run must spawn Gateway stub, Bridge simulator, and add-in loopback
fixture as separate child processes for each binding; retain exact executable
hashes and lifecycle evidence; execute exactly forty terminal cases; and report
zero skipped/not-run cases. Parent-owned predicates must evaluate every
canonical assertion from raw wire/control/snapshot/count observations.

| Sequence | Run id | Start/finish | Duration | Cases | Assertions | Leak verdict | Run report SHA-256 | JUnit SHA-256 | State |
|---:|---|---|---:|---:|---:|---|---|---|---|
| 1 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `not_started` |
| 2 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `not_started` |
| 3 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `not_started` |

Aggregate requirements:

| Check | Required | Current evidence | State |
|---|---|---|---|
| Consecutive identity | Three ordered, non-overlapping runs on one manifest/commit/tree/component stack | Not available | `not_started` |
| Canonical cardinality | 120 aggregate JUnit testcases: forty cases in each of three runs | Not available | `not_started` |
| Binding parity | Every case runs WSS and exact Streamable HTTP/SSE lifecycle | Not available | `not_started` |
| Runtime | Each non-soak suite completes in less than ten minutes | Not available | `not_started` |
| Resource safety | Zero fd growth, journal-pending growth, and orphan processes; memory within the versioned profile | Not available | `not_started` |
| Retained aggregate | Canonical aggregate JSON and deterministic JUnit reopen and hash-validate | Not available | `not_started` |

## One-hour reconnect/proxy-churn soak

The M1 soak is a separate fixed-duration gate. Smoke mode or an accelerated
clock cannot satisfy it.

| Field | Required | Current evidence | State |
|---|---|---|---|
| Requested duration | Exactly `3,600,000` ms | Not available | `not_started` |
| Actual duration | At least `3,600,000` monotonic ms | Not available | `not_started` |
| Bindings | WSS and Streamable HTTP/SSE represented | Not available | `not_started` |
| Churn | Real reconnect and proxy-buffer/churn cycles with heartbeat/control round trips | Not available | `not_started` |
| Cleanup | Zero pending journal state and orphan processes; bounded fd/memory profile | Not available | `not_started` |
| Retained report | Canonical soak JSON plus hashed metrics JSONL on the freeze tree | Not available | `not_started` |

## Section 22 evidence matrix

| Section 22 requirement | Acceptance evidence | Current evidence | State |
|---|---|---|---|
| Payload/conditional schemas and byte-stable generated types | Exact freeze-tree protocol tests, conformance schema vectors, and clean generated diff | Candidate implementation exists; freeze-tree output pending | `in_progress` |
| Complete Section 21 suite | Three-run aggregate and retained per-case parent evidence | Not available | `not_started` |
| WSS and Streamable HTTP/SSE proxy/interoperability parity | Raw per-binding transport observations plus equal journal/resume outcomes | Not available | `not_started` |
| Exact loopback fixture contract | C04, C13, C14, C19, C22, C23, C33 and related raw/count evidence | Not available | `not_started` |
| Batchable-command restrictions and atomic rollback acceptance | Exact `batchable:true` command set, one-frame commit/rollback, model digest, and owner acceptance record | Executable owner-acceptance evidence not yet linked | `in_progress` |
| GAP-7 RBP artifact carrier | C15/C32/C40 stream, descriptor, digest, size, retransmission, confinement, cleanup evidence | Not available | `not_started` |
| Exact RES-21 materialization | Gateway audit and Bridge journal rows showing literal `rsid + "/" + invocation_id` for the same invocation | Not available | `not_started` |
| Review/R-F record | Dated closure review and every normative implementation amendment in `docs/decisions/DP-log.md` | W1 records exist; final harness-finding review pending | `in_progress` |

## Freeze decision

**Current verdict: NOT FROZEN.** O1 remains `1.0-rc.1`; M1 remains
`in_progress`; `rbp/v1.0.0` is absent. The verdict may become `passed` only in
the evidence-closing protected PR after all rows above are green and all
retained hashes reopen successfully from the candidate tree. Milestone-owner
promotion from `passed` to `accepted` remains a separate decision.
