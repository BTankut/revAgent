# M1 O1/RBP v1.0 Semantic-Freeze and Deferred Tag Evidence

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
three-run aggregate, real one-hour reconnect/proxy-churn soak,
WSS/Streamable HTTP/SSE proxy-interoperability evidence, and tag-identity
validation. The latter lane may run in parallel with M2/M3 and does not block
their start. O1-T7 real-add-in and DP-10 client evidence remain separate
pilot-entry gates.

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
| Pre-R-F executable predecessor suite | [CI 30163800736](https://github.com/BTankut/revAgent/actions/runs/30163800736), [add-in 30163800756](https://github.com/BTankut/revAgent/actions/runs/30163800756), and [Bridge 30163800734](https://github.com/BTankut/revAgent/actions/runs/30163800734): Engineering, Gateway, add-in, Bridge, and GitGuardian green; generated diff clean; protocol 303/303; add-in fixture 55/55; Gateway MCP surface 4/4; Gateway stub 78/78; Bridge simulator 214/214; conformance 59 files and 365/365 tests across 5/5 serial shards | The final R-F documentation head must produce its own green protected check rollup before merge; PR #290 is the authoritative gate report |
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
4. In the separate tag lane, run and validate the three-run retained
   aggregate, one-hour soak, and WSS/Streamable HTTP/SSE
   proxy-interoperability evidence against the protected candidate. This work
   is non-blocking for M1/M2/M3.
5. Only after every defined tag-closure check validates may the annotated tag
   be created, and it MUST target the exact protected candidate commit.
6. Record the immutable evidence and tag in a later evidence-record-only
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
| Executable source commit | Full 40-character clean final PR head used by the required protected checks | Recorded by PR #290 head and immutable check rollup | `closes_on_green_merge` |
| Candidate tree | Full 40-character tree of the final PR head | Recorded by PR #290 and verified in the closeout report | `closes_on_green_merge` |
| Protected candidate commit | Full 40-character protected-`main` squash SHA whose tree exactly equals the candidate tree | Resolved by PR #290 protected merge and closeout verification | `closes_on_merge` |
| M1 full-suite source | Exact current-candidate commit/tree and green protected check rollup | PR #290 final-head required checks; predecessor full-suite runs 30163800736/30163800756/30163800734 are green | `passed` |
| Aggregate-bound source | Exact protected candidate and component hashes repeated by all three tag-closure run reports | `not_yet_available` | `deferred_non_blocking` |
| One-hour-soak source | Exact same protected candidate and component hashes as the tag aggregate | `not_yet_available` | `deferred_non_blocking` |
| Freeze tag | Annotated `rbp/v1.0.0` resolving to the protected candidate commit, created only after all tag evidence and identity checks validate | Not created | `deferred_non_blocking` |
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
# Produce and validate the retained three-run aggregate, real one-hour soak,
# WSS/Streamable HTTP/SSE proxy-interoperability evidence, and exact identities.

# Only after every defined tag-closure check succeeds:
git tag -a rbp/v1.0.0 <protected-candidate-commit> -m "Freeze O1/RBP v1.0"
git rev-parse rbp/v1.0.0^{commit}
git push origin rbp/v1.0.0
```

The executable-source and protected-candidate tree outputs MUST be
byte-identical, and `git diff --exit-code` MUST be clean, before M1 is reported
closed or the later tag command is run. The first status command MUST produce
no output when the source is locked. A dirty source, executable-input change,
generated-file drift, or source/protected tree mismatch leaves the affected
gate red. It does not authorize an assistant-created rerun or expanded
evidence cycle: any repetition is exactly what the governing gate requires or
what an R-G operator card explicitly authorizes under R-H. An
evidence-record-only follow-up does not invalidate the candidate only when its
diff is limited to evidence/status records and it leaves the tag target
unchanged. No step authorizes a direct push to `main`.

## O1 work-item evidence

| Item | Required executable evidence | Current evidence | State |
|---|---|---|---|
| O1-T1 | Complete protocol schemas, generated types, and generate-then-clean-diff gate | Generated diff and 303 protocol tests pass; PR #290's final protected check rollup is authoritative | `passed` |
| O1-T2 | Shared FSM/digest/sequence/hold implementation consumed by T4/T5 | PR #282 merged; shared-library cases pass in PR #290's current-candidate suite | `passed` |
| O1-T3 | Separate add-in loopback fixture process with framing, capability, fault, count, batch, and artifact evidence | PRs #283–#285 merged; fixture is 55/55 in the PR #290 check rollup | `passed` |
| O1-T4 | Separate Bridge simulator process with both bindings, durable journal/holds, recovery, and artifact spool | PR #287 merged; current-candidate protected package gate is 214/214; earlier three determinism runs were 211/211 each | `passed` |
| O1-T5 | Separate Gateway stub process with both bindings, auth/session tables, dispatch, resume, proxy/fault controls, and artifact sink | PR #286 merged; Gateway stub is 78/78 in the PR #290 check rollup | `passed` |
| O1-T6 | One complete current-candidate Section 21 suite across both bindings, green protected check rollup, suite under ten minutes, zero fd/journal/orphan leak, and bounded memory | Full PR suite is green: 59 files and 365/365 tests across 5/5 serial shards; immutable final-head checks remain a protected merge condition | `passed` |
| O1-T8 | Harness findings folded into the candidate; canonical `1.0` metadata and protocol constant; this ledger; green protected tree-equal merge | Barış Tankut accepted M1 and the add-in owner evidence on 2026-07-25; RES-28 is recorded; PR #290 protected merge is the final mechanical close | `accepted` |

## Deferred tag closure — three-run conformance aggregate

This evidence is required for `rbp/v1.0.0`, not for M1 or M2/M3 start. Every
run must spawn Gateway stub, Bridge simulator, and add-in loopback
fixture as separate child processes for each binding; retain exact executable
hashes and lifecycle evidence; execute exactly forty terminal cases; and report
zero skipped/not-run cases. Parent-owned predicates must evaluate every
canonical assertion from raw wire/control/snapshot/count observations.

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
| Retained report | Canonical soak JSON plus hashed metrics JSONL bound to the executable candidate commit/tree | Not available | `deferred_non_blocking` |

## RES-28 tag-close execution status — 2026-07-26

Barış Tankut conditionally authorized this separate tag-close lane on
2026-07-26: produce the three defined evidence classes against the M1
candidate, and create the signed tag only if all three validate. The execution
identity is fixed independently of later `main` progress:

- candidate commit:
  `b3cca906ec90d0068df489407d3e0ce7254a308e`;
- candidate tree:
  `e2cf3849e24c1c5b7e5061d35af74ea48a5f77f7`;
- prepared authority set: `rbp-v1.0-b3cca906ec90-s13`;
- authority-lock SHA-256:
  `fb7e43638a9379cb407798b9645c3fe489f55904eeec0793bd433357df6c4df3`;
- authority-runner SHA-256:
  `567079ff43e114070390638f2d4831cde5740d3bcca68c00141fd521e5fb7180`.

No RES-28 test, canonical retained run, or soak command was started during this
attempt. Both fresh evidence roots remained absent, so no partial output is
being promoted as retained evidence. Local and remote `rbp/v1.0.0` also
remained absent.

The shared Windows runner was continuously occupied by higher-priority M2/M3
PR, review, post-merge CI, and signed-CD work. During that window two
independent M3 Gateway jobs ended in the same Vitest 3.2.7 worker/parent RPC
error, `Timeout calling "onTaskUpdate"`, after shard 2 had passed 56 tests with
no assertion failure. The same PR SHA passed shard 2 as 61/61 and all five
shards on its immediately retried run. The candidate, that PR head, and its
protected merge have byte-identical `packages/rbp-conformance`, Vitest
configuration, test runner, and package lock inputs. Process correlation found
the red runs overlapped additional Node/Python/.NET or local `test-ci.ps1`
work, while the green retry did not. This is therefore classified as a
shared-runner/Vitest IPC false-red risk, not a demonstrated RBP semantic
failure.

Under R-H, those scheduling diagnostics do not add a fourth tag gate and do
not replace any required evidence. Under the operator's M2/M3 priority rule,
starting the roughly four-hour RES-28 sequence in that environment would make
its result untrustworthy and delay critical-path work. Execution is deferred
until a reserved quiet window has:

1. no queued or active M2/M3/CI/CD work;
2. three consecutive 50-second observations of the runner online and idle;
3. no Vitest/conformance, `test-ci`, or .NET test/build workload; and
4. enough uninterrupted time for the operator-directed 365-test suite three
   times, the canonical three-run aggregate, and the real one-hour soak.

If the same RPC signature occurs after those preconditions hold, it is an
evidence-set red and MUST NOT be blindly rerun. If a new priority job or local
test starts during the sequence, the collision must be retained as scheduling
evidence and the RES-28 attempt rescheduled rather than represented as a
product verdict.

## Section 22 evidence matrix

| Section 22 requirement | Acceptance evidence | Current evidence | State |
|---|---|---|---|
| Payload/conditional schemas and byte-stable generated types | Exact candidate protocol tests, conformance schema vectors, and clean generated diff | Generated diff clean and protocol 303/303 in the green PR suite | `passed` |
| Complete Section 21 suite | One full current-candidate suite with a green protected check rollup | 59 files / 365 tests / 5 serial shards green; final-head rollup remains protected by PR #290 | `passed` |
| Exact loopback fixture contract | C04, C13, C14, C19, C22, C23, C33 and related raw/count evidence | Fixture 55/55 and current-candidate harness gate pass | `passed` |
| Batchable-command restrictions and atomic rollback acceptance | Exact `batchable:true` command set, one-frame commit/rollback, model digest, and owner acceptance record | Barış Tankut, add-in implementation owner: accepted 2026-07-25 | `accepted` |
| GAP-7 RBP artifact carrier | C15/C32/C40 stream, descriptor, digest, size, retransmission, confinement, cleanup evidence | Current-candidate harness gate passes | `passed` |
| Exact RES-21 materialization | Gateway audit and Bridge journal rows showing literal `rsid + "/" + invocation_id` for the same invocation | Current-candidate Bridge/harness gates pass | `passed` |
| Review/R-F record | Dated closure review and every normative implementation amendment in `docs/decisions/DP-log.md` | M1 closing approval and RES-28 recorded on 2026-07-25 | `passed` |
| Deferred tag: retained three-run aggregate | Three validated consecutive reports on the protected candidate | Not available | `deferred_non_blocking` |
| Deferred tag: WSS and Streamable HTTP/SSE proxy/interoperability parity | Raw per-binding proxy observations plus equal journal/resume outcomes | Not available | `deferred_non_blocking` |
| Deferred tag: one-hour soak | Validated 3,600,000 ms report and metrics bound to the protected candidate | Not available | `deferred_non_blocking` |

## Freeze decision

**M1 KAPANIŞ: ONAY.** O1 has canonical `1.0` candidate bytes, one full green
current-candidate suite, the dated RES-28 review, and named add-in owner
acceptance. Inclusion of this record through PR #290's green, tree-equal
protected squash merge establishes **RBP/1 FROZEN** and M1 `accepted`.
`rbp/v1.0.0` remains absent and separately pending until the defined
three-run/soak/proxy-interoperability tag evidence validates. That pending tag
does not block M2/M3, but this closeout does not itself authorize either
kickoff. A substantive semantic or safety finding remains governed by R-F and
Section 7.3.
