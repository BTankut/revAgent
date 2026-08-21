# Repository Git topology and programme status

- **Snapshot date:** 2026-08-21
- **Protected-main anchor:** `6cd63fadf3c5fd480603e41363b8d5af43b383c7`
- **Scope:** the 155 live `origin` heads and the preserved local recovery
  surface on the coordinator workstation

This record separates two facts that must not be collapsed:

1. **Branch mechanics** say whether a live remote head is a merged-PR source,
   an open-PR source, a closed-unmerged source, has no PR record, or is `main`.
2. **Programme status** says whether a body of work is complete, paused,
   stopped, or intended to resume.

A merged source branch can belong to a paused programme without containing
unmerged work. Conversely, an open draft can be residue of a stopped programme.
The two views below cross-reference one another without changing either fact.

## What a reviewer should conclude

- The 155 remote heads do **not** represent 155 parallel active efforts.
- 136 are retained merged-PR source branches. They are deliberately retained
  history and are not active merely because their remote heads still exist.
- Six are open drafts; five are residue of the stopped Updater Closure
  programme and one has no recorded resume or cancellation decision.
- The Spatial Context Engine is implemented on `main`, backed by a tracked plan
  and four acceptance/review records, and accepted through Phase 1B. Its retained
  source branches are mechanically merged history, not suspended code branches.
- A large local branch/worktree/stash recovery set is intentionally preserved.
  Branch retention is the operator's recovery policy; this record authorizes no
  local or remote deletion.

## Programmes and their status

### Spatial Context Engine

> **OPERATOR-CONFIRMED — 2026-08-21.** Accepted through Phase 1B; Phase 1C has
> not started. The programme is deliberately paused for
> architecture-migration sequencing and will resume when that sequencing
> permits.

The sequencing and resumption statement above is current operator intent. It is
**not** derived from an earlier tracked repository statement. The tracked
evidence independently establishes the accepted implementation boundary and
that Phase 1C is unstarted and unauthorized:

| Tracked evidence | What it establishes |
| --- | --- |
| [`docs/REVAGENT_SPATIAL_CONTEXT_ENGINE_PLAN.md`](../REVAGENT_SPATIAL_CONTEXT_ENGINE_PLAN.md), lines 3-12 and 645-685 | Canonical roadmap; Phase 0, Phase 1A and Phase 1B complete; Phase 1C and later phases unstarted |
| [`docs/REVAGENT_SPATIAL_PHASE0_ACCEPTANCE.md`](../REVAGENT_SPATIAL_PHASE0_ACCEPTANCE.md), lines 142-180 | Phase 0 real-model acceptance boundary |
| [`docs/REVAGENT_SPATIAL_PHASE0_HOTFIX.md`](../REVAGENT_SPATIAL_PHASE0_HOTFIX.md), lines 3-7 | Post-acceptance real-model hardening, explicitly still inside Phase 0 |
| [`docs/REVAGENT_SPATIAL_PHASE1A_ACCEPTANCE.md`](../REVAGENT_SPATIAL_PHASE1A_ACCEPTANCE.md), lines 347-362 | Phase 1A Gates A-E and completion record |
| [`docs/REVAGENT_SPATIAL_PHASE1B_ACCEPTANCE.md`](../REVAGENT_SPATIAL_PHASE1B_ACCEPTANCE.md), lines 468-484 | Phase 1B Gates A-E, signed delivery, rollout closure and completion record |

#### Main-owned implementation surface: 141 paths

`spatial-related` is an ownership rule, not a Git-native predicate. This
snapshot defines the bounded surface as:

- **129** tracked paths whose pathname contains `spatial`, matched with
  culture-invariant case folding; plus
- **12** directly wired integration paths whose names do not contain
  `spatial`.

The ordinally sorted 141-path list, serialized as UTF-8 with LF separators and
a final LF, has SHA-256:

```text
f3f4d1915dfb8005cbac2d46668ff1135dfee53d1fe1423f9683a59179f0397c
```

The 12 integration paths are:

```text
docs/PLATFORM_ARCHITECTURE.md
evals/evals.json
installer/runtime-mcp-server/build/index.js
installer/runtime-mcp-server/build/tools/register.js
installer/runtime-mcp-server/build/utils/telemetry.js
installer/runtime-mcp-server/package.json
installer/runtime-mcp-server/release/index.js
installer/runtime-mcp-server/src/index.ts
installer/runtime-mcp-server/src/tools/register.ts
installer/runtime-mcp-server/src/utils/telemetry.ts
packages/gateway/registry-seed.json
packages/gateway/src/toolBindings.ts
```

On this Turkish-locale Windows host, PowerShell
`-match '(?i)spatial'` returns 124 because it misses the uppercase
`REVAGENT_SPATIAL_*.md` paths. A .NET regex with `IgnoreCase |
CultureInvariant` returns the correct pathname count of 129. Broader questions
produce broader surfaces: content grep returns 188 paths, while the union of
the changed paths in spatial delivery PRs #214, #215 and #217-#220 returns 179.
Every quoted count must name the surface it measured.

#### Physical ownership and Gateway mapping

The engine remains in the legacy workstation runtime, not in a new
`packages/**` implementation subtree:

```text
installer/runtime-mcp-server/src/spatial/**
installer/runtime-mcp-server/src/tools/*spatial*.ts
installer/runtime-mcp-server/build/spatial/**
installer/runtime-mcp-server/schemas/spatial/v0.1|v0.2|v0.3/**
installer/runtime-mcp-server/release/schemas/spatial/v0.1|v0.2|v0.3/**
src/revit-plugin/revAgentCommandSet/Commands/Spatial/**
src/revit-plugin/revAgentPlugin/Core/SpatialChangeTracker.cs
evals/schemas/spatial-phase1b-agent-evidence-v2.schema.json
```

`packages/gateway/registry-seed.json` seeds entries for all four legacy-runtime
handlers, but it does not contain or govern executor fields. Executor governance
is in `packages/gateway/src/toolBindings.ts`:

| Tool | Gateway binding |
| --- | --- |
| `capture_spatial_snapshot` | `bridge`, `hybrid: true` — Revit extraction leg followed by Gateway-side store commit |
| `query_spatial_context` | `internal_mcp` |
| `compare_spatial_snapshots` | `internal_mcp` |
| `summarize_spatial_state` | `internal_mcp` |

The accurate architecture statement is: **the Gateway seeds all four
legacy-runtime spatial handlers; query, compare and summarize execute as
`internal_mcp`, while capture is explicitly hybrid and bridge-bound for its
Revit extraction leg.**

#### Branch cross-reference

The five live remote heads retained for this programme are split mechanically
between [merged-PR sources](#merged-pr-source-branches--136) and
[no-PR-record heads](#no-pr-record--8):

```text
agent/spatial-context-engine-plan       no PR; original plan seed
agent/mark-spatial-phase0-complete      merged PR #217; Phase 1A implementation despite the stale branch name
codex/mark-spatial-phase1a-complete     merged PR #218
agent/implement-spatial-phase1b         merged PR #219
codex/close-spatial-phase1b             merged PR #220
```

The Phase 0 and Phase 0 hotfix source branches are no longer advertised, but
their work is merged through PRs
[#214](https://github.com/BTankut/revAgent/pull/214) and
[#215](https://github.com/BTankut/revAgent/pull/215).

### Updater Closure

The programme was stopped by the repository owner's ruling in
[#260](https://github.com/BTankut/revAgent/pull/260), which was closed without
merge after the target-architecture decision:

- K1-K3 were stopped as polish on the retiring NAS updater.
- E1 was stopped by default; the existing manual prestage remains an emergency
  fallback if a pre-cutover need is later authorized.
- E2 was cancelled because fleet cutover removes the strand problem and bridge
  O9 owns the new self-update mechanism.

Its visible remote residue is one
[closed-unmerged head](#closed-unmerged-pr-source-branches--4) and five
[open draft heads](#open-pr-source-branches--6):

```text
claude/updater-closure-work-order   closed-unmerged PR #260
codex/updater-closure-k1            open draft PR #261
codex/updater-closure-k2            open draft PR #262
codex/updater-closure-k3            open draft PR #263
codex/updater-closure-e1            open draft PR #264
codex/updater-closure-e2            open draft PR #265
```

The five open drafts are not active work merely because GitHub still reports
them open.

## Mechanical remote branch accounting

Live `origin` inventory on 2026-08-21:

| Mechanical class | Count | Rule |
| --- | ---: | --- |
| Merged-PR source | 136 | Live tip equals the exact head SHA of at least one merged same-repository PR |
| Open-PR source | 6 | Live tip is the source of a currently open PR; open takes precedence over older PRs that reused the branch name |
| Closed-unmerged PR source | 4 | A same-repository PR record exists, no PR is open, and none merged |
| No PR record | 8 | Neither branch-name nor tip-SHA association finds a PR |
| `main` | 1 | Protected authoritative baseline |
| **Total** | **155** | |

### Merged-PR source branches — 136

All 136 live tips equal their merged PR head SHA. Retention is deliberate; it
does not make these branches active.

Spatial programme cross-references included in this mechanical class:

```text
agent/mark-spatial-phase0-complete  -> #217
codex/mark-spatial-phase1a-complete -> #218
agent/implement-spatial-phase1b      -> #219
codex/close-spatial-phase1b          -> #220
```

The remaining 132 merged sources are:

```text
agent/harden-codex-updater-boundary -> #221
agent/nas-crypto-snapshot-compat -> #222
ci/self-hosted-job-timeouts -> #341
claude/migration-release-freeze -> #267
claude/target-architecture-implementation-plan -> #266
claude/updater-stabilization-work-order -> #258
codex/bootstrap-direct-gui-createprocess -> #226
codex/bootstrap-local-trusted-keys-prestage -> #225
codex/bootstrap-shared-ancestor-legacy-migration -> #224
codex/bootstrap-shared-parent-hotfix -> #223
codex/ci-default-runner-bootstrap -> #352
codex/ci-scoped-gates -> #325
codex/clean-machine-stable-bootstrap -> #247
codex/docs-01-petrucci-workstation-authority -> #374
codex/docs-ci-runner-rules -> #353
codex/fix-bootstrap-permissions-sibling -> #231
codex/fix-claude-review-failure-comment -> #147
codex/fix-installer-origin-acl-mask -> #230
codex/fix-machine-hidden-updater-launcher -> #259
codex/fix-pilot-api-docs-schedule-contracts -> #213
codex/fix-ps5-file-replace-backup -> #232
codex/fix-release-tree-hash-compatibility -> #229
codex/fix-stable-gui-legacy-bootstrap -> #251
codex/gateway-windows-path-alias-regression -> #346
codex/m2-closure-package -> #366
codex/m2-gw16-batch -> #363
codex/m2-gw19-instruction-packaging -> #364
codex/m2-gw20-promotion-governance -> #365
codex/m2-m3-acceptance-record -> #367
codex/m4-00-rfc8785-owner -> #368
codex/m4-01-preprod-identity -> #369
codex/m4-02-lan-test-composition -> #370
codex/m4-03-engineering-seam -> #372
codex/m4-04a-preproduction-serving -> #375
codex/m4-04a2-secret-handoff -> #376
codex/m4-04a3-refusal-observer -> #377
codex/m4-04a4-client-bearer-broker -> #378
codex/m4-04a5-enrollment-file-consumer -> #379
codex/m4-04a7-value-free-audit-export -> #380
codex/m4-04b-handoff-source-repair -> #382
codex/m4-04b-tracker-closure -> #381
codex/m4-credential-tracker-closure -> #373
codex/m4-r3-tls-timestamp-guard -> #383
codex/maint-01-production-watchdog -> #371
codex/pilot-coordinator-heartbeat-stability -> #349
codex/pilot-cross-process-fixtures -> #348
codex/pilot-load-stable-tests -> #347
codex/pilot-release-scoped-node-msi -> #227
codex/pilot-unblock -> #351
codex/plan-m2-tracker -> #354
codex/powercut-writer-lease-stability -> #350
codex/res28-evidence-record -> #322
codex/res36-tag-record -> #323
codex/stable-gui-desktop-shortcut -> #242
codex/usage-evidence-action-protocol -> #205
codex/usage-routing-tool-guidance -> #206
codex/usage-schedule-visual-policy-plan -> #204
codex/usage-send-code-classification -> #202
codex/usage-send-code-weekly-backlog -> #203
codex/wp1-m0-o1-v0-9 -> #269
codex/wp1-m1-addin-loopback-contract -> #280
codex/wp1-m1-addin-loopback-fixture -> #283
codex/wp1-m1-atomic-batch-result-fix -> #285
codex/wp1-m1-bridge-simulator-postfix2 -> #287
codex/wp1-m1-conformance-manifest -> #290
codex/wp1-m1-fixture-signal-readiness -> #284
codex/wp1-m1-gateway-stub-audit-fixes -> #286
codex/wp1-m1-pre-negotiation-envelope -> #281
codex/wp1-m1-protocol-fsm -> #282
codex/wp1-m1-rbp-schemas -> #279
codex/wp1-m1-rbp-spec-freeze -> #278
codex/wp2-m0-monorepo-scaffold -> #270
codex/wp2-m0-transport-spike -> #272
codex/wp2-m2-dual-era-endpoint -> #315
codex/wp2-m2-entitled-registry-view -> #311
codex/wp2-m2-gate-repair -> #320
codex/wp2-m2-gateway-ci -> #309
codex/wp2-m2-gateway-ci-required-context -> #310
codex/wp2-m2-gw1-collector -> #342
codex/wp2-m2-gw10-north-mcp -> #359
codex/wp2-m2-gw12-rbp-ingress -> #361
codex/wp2-m2-gw2-service-shell -> #344
codex/wp2-m2-gw3-registry-seed -> #345
codex/wp2-m2-gw4-durable-recovery -> #357
codex/wp2-m2-gw4-invocation-authority -> #356
codex/wp2-m2-gw8-confirmation -> #358
codex/wp2-m2-gw9-file-resources -> #360
codex/wp2-m2-mode-a-core -> #312
codex/wp2-m2-north-registry-dispatch -> #291
codex/wp2-m2-north-vertical-slice -> #355
codex/wp2-m2-request-state -> #316
codex/wp2-m2-res23-alignment -> #288
codex/wp2-m2-sdk-v2-decision -> #313
codex/wp2-m2-sdk-v2-packages -> #314
codex/wp3-m3-addin-doc-context -> #329
codex/wp3-m3-addin-execute-batch -> #328
codex/wp3-m3-addin-hardening -> #300
codex/wp3-m3-addin-parser -> #295
codex/wp3-m3-addin-session-routing -> #305
codex/wp3-m3-addin-transport -> #294
codex/wp3-m3-batch-fanout -> #327
codex/wp3-m3-conflict-gate -> #334
codex/wp3-m3-contracts -> #292
codex/wp3-m3-enrollment-gate-split -> #306
codex/wp3-m3-enrollment-p3t8 -> #330
codex/wp3-m3-enrollment-store -> #297
codex/wp3-m3-fixture-integration -> #335
codex/wp3-m3-holdid-derivation -> #333
codex/wp3-m3-invocation-journal-ops -> #307
codex/wp3-m3-invoke-dispatch -> #324
codex/wp3-m3-rbp-alignment -> #289
codex/wp3-m3-rbp-codec -> #299
codex/wp3-m3-rbp-connection -> #302
codex/wp3-m3-rbp-coordinator -> #304
codex/wp3-m3-rbp-invocation-journal -> #303
codex/wp3-m3-rbp-primitives -> #296
codex/wp3-m3-service -> #293
codex/wp3-m3-watcher-fallback -> #331
codex/wp3-m3-windows-attestation -> #298
codex/wp3-m3-worker-composition -> #326
codex/wp3-m3-worker-runtime -> #332
codex/wp5-m0-compose-skeleton -> #273
codex/wp8-m0-ci-freeze-skeleton -> #271
codex/wp8-m0-decision-checkpoint -> #268
codex/wp8-m0-net01-evidence -> #276
codex/wp8-m0-plan-artifacts -> #274
codex/wp8-m1-freeze-intake -> #277
codex/wp9-m0-client-matrix -> #275
docs/m3-gate-evidence -> #340
m4-04b-session2-tracker -> #384
m4-repo-review-readiness -> #385
perf/rbp-single-preparation -> #343
```

### Open-PR source branches — 6

All six PRs are drafts. None is M4 work and none belongs to the Spatial Context
Engine programme.

| PR | Live head | Purpose | Programme status | M4 work? |
| --- | --- | --- | --- | --- |
| [#301](https://github.com/BTankut/revAgent/pull/301) | `claude/self-hosted-runner-actions-a0kieu` | Change the Claude review model from Opus 4.8 to Opus 5 | Intent unclassified; observably dormant, with no resume or cancellation record | No |
| [#261](https://github.com/BTankut/revAgent/pull/261) | `codex/updater-closure-k1` | K1 updater documentation/history closure | Updater Closure; stopped by #260 | No |
| [#262](https://github.com/BTankut/revAgent/pull/262) | `codex/updater-closure-k2` | K2 stale-bootstrap TEMP cleanup activation | Updater Closure; stopped by #260 | No |
| [#263](https://github.com/BTankut/revAgent/pull/263) | `codex/updater-closure-k3` | K3 GUI stderr ownership | Updater Closure; stopped by #260 | No |
| [#264](https://github.com/BTankut/revAgent/pull/264) | `codex/updater-closure-e1` | E1 supervised bootstrap prestage kit | Updater Closure; stopped by default by #260 | No |
| [#265](https://github.com/BTankut/revAgent/pull/265) | `codex/updater-closure-e2` | E2 machine bootstrap trust broker | Updater Closure; cancelled by #260 | No |

### Closed-unmerged PR source branches — 4

| Live head | PR | Recorded disposition |
| --- | --- | --- |
| `claude/updater-closure-work-order` | [#260](https://github.com/BTankut/revAgent/pull/260) | Superseded by the target architecture; owner ruling stops/cancels the programme items above |
| `codex/legacy-cleanup-nonfatal-hotfix` | [#130](https://github.com/BTankut/revAgent/pull/130) | Owner-closed as superseded by the add-on architecture decision |
| `codex/wp2-m2-gate-governance-rk` | [#317](https://github.com/BTankut/revAgent/pull/317) | Owner-closed as superseded by merged #319 |
| `codex/wp2-m2-ci-concurrency` | [#318](https://github.com/BTankut/revAgent/pull/318) | Owner-closed as superseded by merged #320; branch explicitly retained for audit/history |

### No PR record — 8

| Live head | Programme/status cross-reference |
| --- | --- |
| `agent/spatial-context-engine-plan` | Spatial Context Engine; original plan seed, with the plan content represented on `main` |
| `claude/code-protection-obfuscation-04779q` | Unclassified |
| `claude/revagent-repoma-review-93o00g` | Unclassified |
| `codex/pilot-maxpath-fix` | Unclassified |
| `codex/pilot-test-concurrency` | Unclassified |
| `codex/res-28-rbp-status` | Unclassified |
| `codex/wp2-m2-vitest-diagnostics` | Unclassified |
| `docs/c1-hotfix-handoff` | Unclassified |

For the seven unclassified heads, neither branch-name nor tip-SHA lookup finds a
PR; none is an ancestor of `main`, and none has a stable-patch match on `main`.
No active, paused or historical intent is inferred.

### `main` — 1

`main@6cd63fadf3c5fd480603e41363b8d5af43b383c7` is the protected,
authoritative baseline. It is not a retained source branch and is never
described as dormant.

## Preserved local recovery surface

The remote inventory above is what an external reviewer sees. It is not the
whole recovery surface on the coordinator workstation.

State at this snapshot:

| Local surface | Count/state |
| --- | --- |
| Local branches | 253: the original 250 plus three additive archive refs |
| Registered worktrees | 174 present |
| Detached worktrees | 12 |
| Prunable registrations | 0 |
| Stashes | 2, both additionally protected by archive branches |

The primary repository is:

```text
C:\Users\BT\Projects\revAgent
```

Most linked worktrees live under:

```text
C:\Users\BT\Projects\revAgent-worktrees\
```

One registered Claude scratch worktree remains under:

```text
C:\Users\BT\AppData\Local\Temp\claude\C--Users-BT-Projects-revAgent\
2f2b140d-c01c-4ce5-8caa-124aa6359c57\scratchpad\r3
```

The Phase 1 safety inventory found 81 pre-existing local branch tips not
reachable from any advertised remote ref; 46 carried at least one exact variant
without a complete remote tree/patch equivalence proof. Nothing in this record
changes their status or authorizes their deletion.

The highest-risk detached-only commit and both stash objects were given additive
local branch protection:

```text
archive/m1-final-authority-fixes-test-bb1dc4fb
  bb1dc4fb7e46872ca0006beb499df18ac1716f0d

archive/stash-0-m3-rbp-chain
  7cc06d731f191efc87dcca452d1fce3148a0640d

archive/stash-1-t4a-spillover
  2efbdcc62b43f76c6319ab42040905788610628a
```

The stashes remain in place; the archive refs are additive protection, not a
migration. Unique-content worktrees including
`m1-final-authority-fixes-test`, the two provenance-writer-guard raw worktrees,
and `t6-external-evidence` remain registered. The primary checkout retains the
operator-owned untracked file
`docs/REVAGENT_FIVE_RUNNER_WINDOWS_PILOT_RUNBOOK.md`, SHA-256
`d296423a900750ae60fe07fa16cc6458bb2e31c1172b33a7c2e5a7e4b6d47b15`.

This local set is intentionally preserved so that remote omissions or historical
questions can be recovered and measured. Local and remote branch deletion is an
operator decision; this snapshot records no deletion authorization.

### Retained M4 reproduction fixture

The off-repository evidence chain also retains this explicit teardown exemption:

```text
evidence\FIXTURE-rbp-journal-connection-failure\
  journal.db      0e76ec8a18e52ea191b7e66ccceada4f0ec93a19b0c6f04bb9f5a17f8620b7a2
  PROVENANCE.md   777067d9c8fbf82ed82371870996de0671542c0dfa169af9e0fd52a432052042
```

[`M4_GATE_EVIDENCE.md`](M4_GATE_EVIDENCE.md#retained-reproduction-fixture--exempt-from-teardown)
records it as the only artefact that reproduces finding 7 and therefore the
only validation path for `S6`: **archive, never delete**. Its absence from Git is
an intentional evidence boundary, not missing branch content.

## Reproducibility and attribution

The mechanical branch inventory was produced from live `git ls-remote --heads
origin` output joined to same-repository GitHub PR records by exact branch name
and head SHA. The local remote-tracking set had the same 155 names and SHAs.

The application-checkpoint-free repository fingerprint at this snapshot is:

```text
topology refs  c676f501e325cd374f873e2c6fdd546e8c3c75e8ecfc3e74175149307a25b6a8
worktrees      15c72ac6af0dce5ccdd201b34854ed53f256ca6bf5059618d948f665e76f075c
stash          b058ee1b7255e8d95ca5b26b9a471c040403e73bae33fbe984a1ab7941339b71
```

The topology fingerprint is explicitly sorted and excludes Codex's transient
`refs/codex/turn-diffs/**` checkpoint namespace. It measures repository
topology, not the application observing it.

Attribution rules for future updates:

- Branch mechanics must come from live refs and PR state, never programme
  interpretation.
- Programme intent must name its source. The Spatial pause/resume statement is
  operator-confirmed context dated 2026-08-21; it is not back-attributed to the
  earlier acceptance documents.
- A retained merged source branch must not be described as active solely because
  it still exists remotely.
- An open draft must not be described as active when an owner ruling has stopped
  or cancelled its programme.
