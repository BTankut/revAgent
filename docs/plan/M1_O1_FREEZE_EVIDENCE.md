# M1 O1/RBP v1.0 Semantic-Freeze and Deferred Tag Evidence

> **WP12-C39-ROUTE-REBIND-V1 amendment (2026-08-26):** implementation and
> verification are authorized by the recovered Decision Freeze only. The
> capability-gated `session_resume.route_rebind_proof` semantics are not an M1
> acceptance, tag, merge, or deployment claim. Required aggregate WSS and
> Streamable HTTP/SSE C39 evidence plus C38/C29/C28 regressions remain pending.

**Document state:** M1 closing accepted; protected merge closes semantic
freeze; deferred tag ledger remains open

**Protocol candidate:** `1.0`

**Milestone:** M1 — accepted by Barış Tankut, effective when PR #290 reaches
protected `main`

**Tag state:** `rbp/v1.0.0` is not created or authorized by the M1 merge. Its
separate, non-blocking evidence closure remains pending.

This ledger separates two gates under RES-28. M1 requires the executable
O1-T3–T6 artifacts, one complete green current-candidate Section 21 suite with
its protected PR check rollup, the other Section 22 M1 evidence, and a
protected tree-equal squash merge. The later tag closure requires the retained
three-run aggregate, the RES-34 full-Vitest 60-file/373-test/5-shard
acceptance predicate, real one-hour reconnect/proxy-churn soak,
WSS/Streamable HTTP/SSE proxy-interoperability evidence, and protected-tag
identity validation. The latter lane may run in parallel with M2/M3 and does
not block their start. O1-T7 real-add-in and DP-10 client evidence remain
separate pilot-entry gates.

## 2026-07-25 operator closing checkpoint

Barış Tankut recorded `M1 KAPANIŞ: ONAY`, identified himself as the add-in
implementation owner, and accepted the batchable-command restrictions and
atomic rollback evidence. PR #290 is authorized to become ready and to squash
merge after its protected gates are green. The merge freezes RBP/1 and closes
M1; it does not authorize `rbp/v1.0.0` or start M2/M3. Each later lane requires
its separately authorized kickoff.

The following evidence was already produced. Under R-H, only the final green
protected PR check rollup, Section 22 M1 rows, and protected tree equality are
M1 close conditions; supplementary rows do not redefine that gate.

| Gate | Current result | Remaining M1 closure |
|---|---|---|
| Engineering gate | `pwsh -File scripts/test-ci.ps1`: PASS | Protected PR checks still run on the final pushed commit |
| Windows non-Revit gate | Windows PowerShell 5.1 `scripts/test-all.ps1`: PASS | Protected PR checks still run on the final pushed commit |
| Windows protected-script matrix | 11/11 named PS5 installer/updater/security scripts: PASS | None locally; protected PR remains authoritative |
| Pre-R-F executable predecessor suite | [CI 30163800736](https://github.com/BTankut/revAgent/actions/runs/30163800736), [add-in 30163800756](https://github.com/BTankut/revAgent/actions/runs/30163800756), and [Bridge 30163800734](https://github.com/BTankut/revAgent/actions/runs/30163800734): Engineering, Gateway, add-in, Bridge, and GitGuardian green; generated diff clean; protocol 303/303; add-in fixture 55/55; Gateway MCP surface 4/4; Gateway stub 78/78; Bridge simulator 214/214; conformance 60 files and 373/373 tests across 5/5 serial shards | The final R-F documentation head must produce its own green protected check rollup before merge; PR #290 is the authoritative gate report |
| Supplementary Bridge determinism/package boundary | Three independent deterministic runs, 211/211 tests each, `failed=0`; package dry-run: PASS | None; retained as non-blocking supplementary evidence |
| Source-byte attestation | Clean detached raw worktree; every tracked file byte-hashed to protected HEAD with zero mismatches | The required final protected check rollup performs this gate; no separate run is added |

The workstation npm policy has `ignore-scripts=true`; therefore the local
Bridge workflow explicitly rebuilt and verified the allowlisted
`better-sqlite3` native binding before its determinism runs. The repository
workflow uses ordinary `npm ci` with lifecycle scripts enabled. This
environmental step does not weaken or skip the native dependency check.

## Freeze identity

The executable candidate and the evidence record have deliberately separate
identities, and the semantic-freeze and tag gates use them differently:

1. Lock one clean executable source commit and its exact Git tree. The
   worktree MUST be clean before the build; the final protocol constant,
   version/freeze metadata, schemas, generated files, dependency manifests and
   lockfiles, source, tests, fixtures, conformance harness, and build/runtime
   configuration MUST already be present in that tree. Candidate metadata is
   a byte under test, not by itself a freeze verdict.
2. Build from a clean checkout and run one complete current-candidate Section
   21 suite. Its protected PR check rollup and exact head identity are the
   executable M1 gate evidence.
3. Merge the executable candidate only through the protected PR path. A squash
   merge may produce a different commit SHA, but the protected candidate
   commit's Git tree MUST be byte-identical to the tested source tree. If it is
   not, the merge is not the tested candidate. A green, tree-equal protected
   merge establishes M1 semantic freeze.
4. In the separate tag lane, resolve the proposed evidence anchor from
   protected `main`. Report its full 40-character commit SHA and tree SHA for
   operator confirmation before any tag-evidence run is counted. Its
   `docs/specs` and `packages/protocol` tree identities MUST equal the
   semantic-freeze base identities recorded by RES-34; the complete repository
   tree is not required to equal the older semantic-freeze tree.
5. After that confirmation and a separate authorization to execute the tag
   lane, run and validate the three-run retained aggregate, one-hour soak, and
   WSS/Streamable HTTP/SSE proxy-interoperability evidence against that one
   confirmed anchor. This work is non-blocking for M1/M2/M3.
6. Only after every defined tag-closure check validates and tag creation is
   separately authorized may the annotated tag be created. It MUST target the
   exact confirmed tag-evidence anchor.
7. Record the immutable evidence and tag in a later evidence-record-only
   protected PR. That follow-up may change this ledger and other
   non-normative status/evidence links, but it MUST NOT change executable
   inputs, normative protocol content, version metadata, or the tagged anchor.
   Its commit is never the freeze-tag target.

The post-tag evidence-record-only change replaces every `not_yet_confirmed`
and `not_yet_available` field below with a real retained value. The table is
an audit record of already validated facts; editing the table is not an input
to the pass verdict.

| Identity | Required value | Current evidence | State |
|---|---|---|---|
| Executable source commit | Full 40-character clean final PR head used by the required protected checks | Recorded by PR #290 head and immutable check rollup | `closes_on_green_merge` |
| Candidate tree | Full 40-character tree of the final PR head | Recorded by PR #290 and verified in the closeout report | `closes_on_green_merge` |
| Protected semantic-freeze commit | Full 40-character protected-`main` squash SHA whose tree exactly equals the M1 candidate tree | Resolved by PR #290 protected merge and closeout verification | `closes_on_merge` |
| M1 full-suite source | Exact current-candidate commit/tree and green protected check rollup | PR #290 final-head required checks; predecessor full-suite runs 30163800736/30163800756/30163800734 are green | `passed` |
| Proposed tag-evidence anchor | Full 40-character protected-main commit SHA and tree SHA reported for operator confirmation before any evidence run is counted | `not_yet_confirmed` | `deferred_non_blocking` |
| Aggregate-bound source | Exact confirmed tag-evidence anchor and component hashes repeated by all three tag-closure run reports | `not_yet_available` | `deferred_non_blocking` |
| One-hour-soak source | Exact same confirmed tag-evidence anchor and component hashes as the tag aggregate | `not_yet_available` | `deferred_non_blocking` |
| Freeze tag | Annotated `rbp/v1.0.0` resolving to the confirmed tag-evidence anchor, created only after all tag evidence and identity checks validate and tag creation is separately authorized | Not created | `deferred_non_blocking` |
| Evidence-record commit | Full 40-character docs-only protected follow-up SHA; explicitly not the candidate or tag target | `not_yet_available` | `deferred_non_blocking` |

M1 candidate lock and protected-tree verification procedure:

```text
git status --porcelain=v1 --untracked-files=all
git rev-parse <executable-source-commit>
git rev-parse <executable-source-commit>^{tree}

# Run the required one full current-candidate suite and retain its protected
# check rollup.

git fetch origin main --tags
git rev-parse <protected-candidate-commit>^{tree}
git diff --exit-code <executable-source-commit> <protected-candidate-commit> --
git merge-base --is-ancestor <protected-candidate-commit> origin/main
```

Deferred, separately authorized tag-closure procedure:

```text
# Resolve but do not yet count evidence against a proposed protected-main
# anchor. Report both outputs for operator confirmation first.
git fetch origin main --tags
git rev-parse origin/main^{commit}
git rev-parse origin/main^{tree}
git rev-parse b3cca906ec90d0068df489407d3e0ce7254a308e:docs/specs
git rev-parse origin/main:docs/specs
git rev-parse b3cca906ec90d0068df489407d3e0ce7254a308e:packages/protocol
git rev-parse origin/main:packages/protocol

# After operator confirmation and separate execution authorization, produce a
# retained full-Vitest qualification that parses all five shard summaries and
# asserts exactly 60 files / 373 tests / 5 shards. Exit 0 alone is insufficient.
#
# Separately produce and validate the retained three-run 40-case aggregate,
# real one-hour soak, WSS/Streamable HTTP/SSE proxy-interoperability evidence,
# and exact identities.

# Only after every defined tag-closure check succeeds AND tag creation receives
# its own authorization:
git tag -a rbp/v1.0.0 <confirmed-tag-evidence-anchor> -m "Freeze O1/RBP v1.0"
git rev-parse rbp/v1.0.0^{commit}
git push origin rbp/v1.0.0
```

The M1 executable-source and protected semantic-freeze tree outputs MUST be
byte-identical, and `git diff --exit-code` MUST be clean, before M1 is reported
closed. The later tag-evidence anchor may have a different complete tree, but
its RES-34 normative-subtree identities MUST match the semantic-freeze base
and its full commit/tree identities MUST be confirmed before evidence is
counted. The first status command MUST produce no output when the source is
locked. A dirty source, generated-file drift, normative-subtree mismatch, or
unconfirmed anchor leaves the affected gate red. It does not authorize an
assistant-created rerun or expanded evidence cycle: any repetition is exactly
what the governing gate requires or what an R-G operator card explicitly
authorizes under R-H. An evidence-record-only follow-up does not invalidate
the anchor only when its diff is limited to evidence/status records and it
leaves the tag target unchanged. No step authorizes a direct push to `main`.

## O1 work-item evidence

| Item | Required executable evidence | Current evidence | State |
|---|---|---|---|
| O1-T1 | Complete protocol schemas, generated types, and generate-then-clean-diff gate | Generated diff and 303 protocol tests pass; PR #290's final protected check rollup is authoritative | `passed` |
| O1-T2 | Shared FSM/digest/sequence/hold implementation consumed by T4/T5 | PR #282 merged; shared-library cases pass in PR #290's current-candidate suite | `passed` |
| O1-T3 | Separate add-in loopback fixture process with framing, capability, fault, count, batch, and artifact evidence | PRs #283–#285 merged; fixture is 55/55 in the PR #290 check rollup | `passed` |
| O1-T4 | Separate Bridge simulator process with both bindings, durable journal/holds, recovery, and artifact spool | PR #287 merged; current-candidate protected package gate is 214/214; earlier three determinism runs were 211/211 each | `passed` |
| O1-T5 | Separate Gateway stub process with both bindings, auth/session tables, dispatch, resume, proxy/fault controls, and artifact sink | PR #286 merged; Gateway stub is 78/78 in the PR #290 check rollup | `passed` |
| O1-T6 | One complete current-candidate Section 21 suite across both bindings, green protected check rollup, suite under ten minutes, zero fd/journal/orphan leak, and bounded memory | Full PR suite is green: 60 files and 373/373 tests across 5/5 serial shards; immutable final-head checks remain a protected merge condition | `passed` |
| O1-T8 | Harness findings folded into the candidate; canonical `1.0` metadata and protocol constant; this ledger; green protected tree-equal merge | Barış Tankut accepted M1 and the add-in owner evidence on 2026-07-25; RES-28 is recorded; PR #290 protected merge is the final mechanical close | `accepted` |

## Deferred tag closure — three-run conformance aggregate

This evidence is required for `rbp/v1.0.0`, not for M1 or M2/M3 start. Every
run must spawn Gateway stub, Bridge simulator, and add-in loopback
fixture as separate child processes for each binding; retain exact executable
hashes and lifecycle evidence; execute exactly forty terminal cases; and report
zero skipped/not-run cases. Parent-owned predicates must evaluate every
canonical assertion from raw wire/control/snapshot/count observations. The
mechanically separate full-Vitest qualification is an acceptance predicate of
this aggregate class, not a fourth retained run or a fifth RES-28 evidence
class; its 60-file/373-test cardinality is not a field in these 40-case reports.

Protected-main push [run 30480038477](https://github.com/BTankut/revAgent/actions/runs/30480038477),
Gateway job [90671414231](https://github.com/BTankut/revAgent/actions/runs/30480038477/job/90671414231),
measured the qualification parser on
`main@9558fc0b1a60757f43f4813b973cc9e589d45a9a` (tree
`b8856d788a961a0557384c7666609fd8fe112ccc`): all five shard `PASS` records were followed by
`60 files / 373 tests / 5 shards`; an independent `git ls-tree` inventory enumerated 60 tracked
`*.test.ts` files under `packages/rbp-conformance/tests` at the same SHA. This is pre-tag calibration, not
a retained run, a completed qualification for the future tag-evidence set, or selection of the dynamic
RES-34 anchor.

| Sequence | Run id | Start/finish | Duration | Cases | Assertions | Leak verdict | Run report SHA-256 | JUnit SHA-256 | State |
|---:|---|---|---:|---:|---:|---|---|---|---|
| 1 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `deferred_non_blocking` |
| 2 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `deferred_non_blocking` |
| 3 | `not_yet_available` | `not_yet_available` | — | — | — | — | — | — | `deferred_non_blocking` |

Aggregate requirements:

| Check | Required | Current evidence | State |
|---|---|---|---|
| Consecutive identity | Three ordered, non-overlapping runs on one manifest/commit/tree/component stack | Not available | `deferred_non_blocking` |
| Canonical cardinality | 120 aggregate JUnit testcases: forty cases in each of three runs | Not available | `deferred_non_blocking` |
| Full-Vitest qualification predicate | Mechanically separate parsing of all five serial shard summaries MUST assert exactly 60 files, 373 passed tests, and 5/5 passed shards; exit code zero alone is insufficient; this is not a separate RES-28 evidence class | Not available | `deferred_non_blocking` |
| Binding parity | Every case runs WSS and exact Streamable HTTP/SSE lifecycle | Not available | `deferred_non_blocking` |
| Runtime | Each non-soak suite completes in less than ten minutes | Not available | `deferred_non_blocking` |
| Resource safety | Zero fd growth, journal-pending growth, and orphan processes; memory within the versioned profile | Not available | `deferred_non_blocking` |
| Retained aggregate | Canonical aggregate JSON and deterministic JUnit reopen and hash-validate | Not available | `deferred_non_blocking` |

## Deferred tag closure — one-hour reconnect/proxy-churn soak

The tag-closure soak is a separate fixed-duration gate. It is non-blocking for
M1/M2/M3. Smoke mode or an accelerated clock cannot satisfy it.

| Field | Required | Current evidence | State |
|---|---|---|---|
| Requested duration | Exactly `3,600,000` ms | Not available | `deferred_non_blocking` |
| Actual duration | At least `3,600,000` monotonic ms | Not available | `deferred_non_blocking` |
| Bindings | WSS and Streamable HTTP/SSE represented | Not available | `deferred_non_blocking` |
| Churn | Real reconnect and proxy-buffer/churn cycles with heartbeat/control round trips | Not available | `deferred_non_blocking` |
| Cleanup | Zero pending journal state and orphan processes; bounded fd/memory profile | Not available | `deferred_non_blocking` |
| Retained report | Canonical soak JSON plus hashed metrics JSONL bound to the confirmed tag-evidence anchor commit/tree | Not available | `deferred_non_blocking` |

## Section 22 evidence matrix

| Section 22 requirement | Acceptance evidence | Current evidence | State |
|---|---|---|---|
| Payload/conditional schemas and byte-stable generated types | Exact candidate protocol tests, conformance schema vectors, and clean generated diff | Generated diff clean and protocol 303/303 in the green PR suite | `passed` |
| Complete Section 21 suite | One full current-candidate suite with a green protected check rollup | 60 files / 373 tests / 5 serial shards green; final-head rollup remains protected by PR #290 | `passed` |
| Exact loopback fixture contract | C04, C13, C14, C19, C22, C23, C33 and related raw/count evidence | Fixture 55/55 and current-candidate harness gate pass | `passed` |
| Batchable-command restrictions and atomic rollback acceptance | Exact `batchable:true` command set, one-frame commit/rollback, model digest, and owner acceptance record | Barış Tankut, add-in implementation owner: accepted 2026-07-25 | `accepted` |
| GAP-7 RBP artifact carrier | C15/C32/C40 stream, descriptor, digest, size, retransmission, confinement, cleanup evidence | Current-candidate harness gate passes | `passed` |
| Exact RES-21 materialization | Gateway audit and Bridge journal rows showing literal `rsid + "/" + invocation_id` for the same invocation | Current-candidate Bridge/harness gates pass | `passed` |
| Review/R-F record | Dated closure review and every normative implementation amendment in `docs/decisions/DP-log.md` | M1 closing approval and RES-28 recorded on 2026-07-25; RES-34 recorded on 2026-07-29; full dated chain retained in the DP-log | `passed` |
| Deferred tag: retained three-run aggregate | Three validated consecutive reports on the confirmed tag-evidence anchor | Not available | `deferred_non_blocking` |
| Deferred tag: WSS and Streamable HTTP/SSE proxy/interoperability parity | Raw per-binding proxy observations plus equal journal/resume outcomes | Not available | `deferred_non_blocking` |
| Deferred tag: one-hour soak | Validated 3,600,000 ms report and metrics bound to the confirmed tag-evidence anchor | Not available | `deferred_non_blocking` |

## Freeze decision

**M1 KAPANIŞ: ONAY.** O1 has canonical `1.0` candidate bytes, one full green
current-candidate suite, the dated RES-28 review, and named add-in owner
acceptance. Inclusion of this record through PR #290's green, tree-equal
protected squash merge establishes **RBP/1 FROZEN** and M1 `accepted`.
`rbp/v1.0.0` remains absent and separately pending until the defined
three-run aggregate, RES-34 full-Vitest predicate, soak,
proxy-interoperability evidence, and protected-tag identity validation pass.
That pending tag does not block M2/M3, but this closeout does not itself
authorize either kickoff. A substantive semantic or safety finding remains
governed by R-F and Section 7.3.
