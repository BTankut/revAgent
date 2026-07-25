# M1 O1/RBP v1.0 Freeze Evidence

**Document state:** evidence ledger in progress; not a freeze decision

**Protocol candidate:** `1.0` (freeze verdict pending)

**Milestone:** M1

**Tag state:** `rbp/v1.0.0` MUST NOT be created during this draft-gate
checkpoint. Even after the retained evidence and protected-candidate identity
checks below pass, tag creation requires a later explicit operator-channel
closing approval.

This ledger closes O1-T8 only after the executable O1-T3–T6 artifacts and every
M1 item in `docs/specs/O1-bridge-gateway-protocol.md` Section 22 are linked to
one exact executable candidate commit/tree and that exact tree reaches
protected `main`. A schema result, unit-test count, draft PR, or a passing
subset of the forty cases cannot substitute for the retained three-process
suite. O1-T7 real-add-in and DP-10 client evidence remain separate pilot-entry
gates after the protocol freeze.

## 2026-07-24 draft-gate checkpoint

The operator instruction dated 2026-07-23 limits this lane to one draft freeze
PR and its gate report. When the authoritative three-run aggregate and real
one-hour soak are ready, the implementation assistant opens the PR as
**draft**, reports the gate demo and final v0.9→v1.0 diff, and stops. This
checkpoint does not authorize making the PR ready, merging it, creating
`rbp/v1.0.0`, or starting M2/M3.

The following pre-lock executable gates passed on the candidate tree before
the final authority-vector ceremony. They prove implementation readiness, not
the freeze verdict:

| Gate | 2026-07-24 local result | Remaining closure |
|---|---|---|
| Engineering gate | `pwsh -File scripts/test-ci.ps1`: PASS | Protected PR checks still run on the final pushed commit |
| Windows non-Revit gate | Windows PowerShell 5.1 `scripts/test-all.ps1`: PASS | Protected PR checks still run on the final pushed commit |
| Windows protected-script matrix | 11/11 named PS5 installer/updater/security scripts: PASS | None locally; protected PR remains authoritative |
| Workspace/package gate | Generated diff clean; protocol 303/303; add-in fixture 55/55; Gateway stub 78/78; Bridge simulator 211/211; conformance harness 59 files and 365/365 tests across 5/5 serial shards: PASS | GitHub `gateway-gates` supplies the exact Node 20 runner |
| Bridge determinism/package boundary | Three independent deterministic runs, 211/211 tests each, `failed=0`; package dry-run: PASS | Linux workflow reruns on the protected PR |
| Source-byte attestation | Clean detached raw worktree; every tracked file byte-hashed to protected HEAD with zero mismatches | Repeat against the final documentation-complete candidate commit |

The workstation npm policy has `ignore-scripts=true`; therefore the local
Bridge workflow explicitly rebuilt and verified the allowlisted
`better-sqlite3` native binding before its determinism runs. The repository
workflow uses ordinary `npm ci` with lifecycle scripts enabled. This
environmental step does not weaken or skip the native dependency check.

## Freeze identity

The executable candidate and the evidence record have deliberately separate
identities:

1. Lock one clean executable source commit and its exact Git tree. The
   worktree MUST be clean before the build; the final protocol constant,
   version/freeze metadata, schemas, generated files, dependency manifests and
   lockfiles, source, tests, fixtures, conformance harness, and build/runtime
   configuration MUST already be present in that tree. Candidate metadata is
   a byte under test, not by itself a freeze verdict.
2. Build from a clean checkout. All three real conformance runs and the full
   one-hour soak MUST report that same source commit/tree and the exact
   component/executable hashes produced from it.
3. Merge the executable candidate only through the protected PR path. A squash
   merge may produce a different commit SHA, but the protected candidate
   commit's Git tree MUST be byte-identical to the tested source tree. If it is
   not, the merge is not the tested candidate.
4. Independently reopen and validate every retained report, JUnit file,
   metrics stream, manifest, and digest. Only after those validations and the
   protected-tree equality check pass may the annotated tag be created, and it
   MUST target the exact protected candidate commit.
5. Record the immutable evidence and tag in a later evidence-record-only
   protected PR. That follow-up may change this ledger and other
   non-normative status/evidence links, but it MUST NOT change executable
   inputs, normative protocol content, version metadata, or the tagged
   candidate. Its commit is never the freeze-tag target.

The post-tag evidence-record-only change replaces every
`not_yet_available` field below with a real retained value. The table is an
audit record of already validated facts; editing the table is not an input to
the pass verdict.

| Identity | Required value | Current evidence | State |
|---|---|---|---|
| Executable source commit | Full 40-character clean source SHA used to build and run the retained evidence | `not_yet_available` | `in_progress` |
| Candidate tree | Full 40-character `git rev-parse <executable-source-commit>^{tree}` value | `not_yet_available` | `in_progress` |
| Protected candidate commit | Full 40-character protected-`main` squash SHA whose tree exactly equals the candidate tree | `not_yet_available` | `not_started` |
| Aggregate-bound source | Exact executable source commit/tree and component hashes repeated by all three run reports | `not_yet_available` | `in_progress` |
| One-hour-soak source | Exact same executable source commit/tree and component hashes as the aggregate | `not_yet_available` | `in_progress` |
| Freeze tag | Annotated `rbp/v1.0.0` resolving to the protected candidate commit, created only after all evidence and identity checks validate | Not created | `not_started` |
| Evidence-record commit | Full 40-character docs-only protected follow-up SHA; explicitly not the candidate or tag target | `not_yet_available` | `not_started` |

Candidate lock, protected-tree verification, and tagging procedure:

```text
git status --porcelain=v1 --untracked-files=all
git rev-parse <executable-source-commit>
git rev-parse <executable-source-commit>^{tree}

# Run the fresh build, three conformance runs, and one-hour soak here.
# Retain their reports, manifests, component hashes, and digests.

git fetch origin main --tags
git rev-parse <protected-candidate-commit>^{tree}
git diff --exit-code <executable-source-commit> <protected-candidate-commit> --
git merge-base --is-ancestor <protected-candidate-commit> origin/main

# Only after retained-evidence validation also succeeds:
git tag -a rbp/v1.0.0 <protected-candidate-commit> -m "Freeze O1/RBP v1.0"
git rev-parse rbp/v1.0.0^{commit}
git push origin rbp/v1.0.0
```

The executable-source and protected-candidate tree outputs MUST be
byte-identical, and `git diff --exit-code` MUST be clean, before the tag
command. The first status command MUST produce no output when the source is
locked. A dirty source, concurrent protected-branch update incorporated into
the candidate, executable-input change, generated-file drift, rebuild with
different component hashes, or source/protected tree mismatch invalidates the
candidate and requires a new clean commit, fresh build, three new consecutive
runs, and a new full one-hour soak. An evidence-record-only follow-up does not
invalidate the candidate only when its diff is limited to evidence/status
records and it leaves the tag target unchanged. No step authorizes a direct
push to `main`.

## O1 work-item evidence

| Item | Required executable evidence | Current evidence | State |
|---|---|---|---|
| O1-T1 | Complete protocol schemas, generated types, and generate-then-clean-diff gate | Pre-lock generated diff, 303 protocol tests, and conformance vectors pass; final candidate protected-PR run remains to be linked | `in_progress` |
| O1-T2 | Shared FSM/digest/sequence/hold implementation consumed by T4/T5 | PR #282 merged; exact freeze-tree test report to be linked | `passed` |
| O1-T3 | Separate add-in loopback fixture process with framing, capability, fault, count, batch, and artifact evidence | PRs #283–#285 merged; pre-lock fixture gate is 55/55; exact final process identity will be retained by T6 | `passed` |
| O1-T4 | Separate Bridge simulator process with both bindings, durable journal/holds, recovery, and artifact spool | PR #287 merged; pre-lock package gate is 211/211 and three determinism runs are 211/211 each; exact final process identity will be retained by T6 | `passed` |
| O1-T5 | Separate Gateway stub process with both bindings, auth/session tables, dispatch, resume, proxy/fault controls, and artifact sink | PR #286 merged; pre-lock package gate is 78/78; exact final process identity will be retained by T6 | `passed` |
| O1-T6 | Forty canonical cases × two bindings, three consecutive passing runs, retained JSON/JUnit, suite under ten minutes, zero fd/journal/orphan leak and bounded memory | Fail-closed harness gate passes 59 files and 365/365 tests; authoritative three-run aggregate and one-hour soak are still pending | `in_progress` |
| O1-T8 | Harness findings folded into the candidate; canonical `1.0` metadata and protocol constant; this ledger; validated protected-main tag | Candidate metadata and ledger are present; owner acceptance, final R-F review, protected merge, and tag remain pending | `in_progress` |

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
| Retained report | Canonical soak JSON plus hashed metrics JSONL bound to the executable candidate commit/tree | Not available | `not_started` |

## Section 22 evidence matrix

| Section 22 requirement | Acceptance evidence | Current evidence | State |
|---|---|---|---|
| Payload/conditional schemas and byte-stable generated types | Exact freeze-tree protocol tests, conformance schema vectors, and clean generated diff | Pre-lock generated diff and protocol/conformance tests pass; final protected-PR output pending | `in_progress` |
| Complete Section 21 suite | Three-run aggregate and retained per-case parent evidence | Not available | `not_started` |
| WSS and Streamable HTTP/SSE proxy/interoperability parity | Raw per-binding transport observations plus equal journal/resume outcomes | Harness implementation and pre-lock 365/365 gate pass; retained final-run observations pending | `in_progress` |
| Exact loopback fixture contract | C04, C13, C14, C19, C22, C23, C33 and related raw/count evidence | Fixture 55/55 and harness pre-lock gates pass; retained final-run evidence pending | `in_progress` |
| Batchable-command restrictions and atomic rollback acceptance | Exact `batchable:true` command set, one-frame commit/rollback, model digest, and owner acceptance record | Executable owner-acceptance evidence not yet linked | `in_progress` |
| GAP-7 RBP artifact carrier | C15/C32/C40 stream, descriptor, digest, size, retransmission, confinement, cleanup evidence | Harness implementation and pre-lock gates pass; retained final-run evidence pending | `in_progress` |
| Exact RES-21 materialization | Gateway audit and Bridge journal rows showing literal `rsid + "/" + invocation_id` for the same invocation | Pre-lock Bridge/harness gates pass; retained final-run rows pending | `in_progress` |
| Review/R-F record | Dated closure review and every normative implementation amendment in `docs/decisions/DP-log.md` | W1 records exist; final harness-finding review pending | `in_progress` |

## Freeze decision

**Current verdict: NOT FROZEN.** O1 has canonical `1.0` candidate bytes, but M1
remains `in_progress` and `rbp/v1.0.0` is absent. The verdict may become
`passed` only after all retained evidence validates, the protected candidate
tree equals the tested executable source tree, and the annotated tag resolves
to that exact protected candidate commit. A later evidence-record-only
protected PR records those immutable facts without becoming or modifying the
tagged candidate. Milestone-owner promotion from `passed` to `accepted`
remains a separate decision. Under the current checkpoint, even a green draft
gate report stops before ready/merge/tag and awaits explicit operator-channel
closing approval.
