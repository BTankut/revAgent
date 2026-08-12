# M4 Gateway Live-Path Gate Evidence

**Evidence state:** `in_progress`

**Acceptance state:** `not_submitted`

**Plan binding:** `M4-02` is the planner-approved decomposition of the M4
Gateway live-path work. It prepares a deterministic pre-production composition
for later bounded host proof; it does not by itself satisfy or enlarge the M4
milestone gate.

**Exact slice base:**
[`42f830ac89e447360a4ebc71120300d5f935fe34`](https://github.com/BTankut/revAgent/commit/42f830ac89e447360a4ebc71120300d5f935fe34)

## Authorization ceiling

This ledger is limited to a LAN/test endpoint and repo-local preparation.
Neither this document nor the M4-02 planner binding authorizes host access,
credential use, public DNS or tunnel changes, external/live client execution,
live Revit access, or any write/confirmation action. Production deployment,
runner, signing, CD, and NAS surfaces remain untouched.

The pre-production composition must remain explicit and fail closed: no
production-mode bypass, no implicit credentials, no second identity path, and
no claim that deterministic identity fixtures prove real OAuth or device-token
durability.

## M4-02 repo-preparation evidence

| Field | Evidence | State |
|---|---|---|
| Exact implementation head | [`0b1a641fec44cedb7776b07b9400747b87ec485b`](https://github.com/BTankut/revAgent/commit/0b1a641fec44cedb7776b07b9400747b87ec485b); tree `1681362889585cd63df66b2c29dbae20862e5409` | `passed` |
| Changed-path inventory | 11 files, all under `packages/gateway`; 1,604 insertions / 61 deletions. The new composition owns one identity/store graph and adds only its tests, server trust/lifecycle guards, public exports, and README contract. | `passed` |
| Targeted test evidence | Node `v24.14.0`: 4 files / 40 tests; independent final review: 6 files / 49 tests | `passed` |
| Local/full-gate evidence | Gateway lint, type-check, build, and 27 files / 267 tests passed. Handler manifest remained `sha256:cb193dc22716e12217edc4f5516c7145eb6e42a488c6360777b01e977644ecde`. Two independent final reviews found no remaining P0-P2 issue. | `passed` |
| GitHub run and attempt links | Scope head: [Gateway CI 31585382544, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31585382544/attempts/1) passed; [CI 31585382546, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31585382546/attempts/1) passed Engineering but failed the diff-external RBP watchdog family described below. Exact implementation/evidence-head protected checks are pending push. | `partial` |
| Immutable image reference and digest | No image was published, deployed, or selected. M4-HOST requires a later exact protected-main immutable image reference/digest; the current image remains production/fail-closed. | `pending_m4_host` |
| Lockfile/protocol/workflow protected-surface equality | No diff in `package-lock.json`, `packages/gateway/package.json`, `packages/protocol/**`, `packages/gateway/src/main.ts`, Gateway Dockerfile, `deploy/**`, or `.github/**`. Base/head blobs: lockfile `b3d8df2755b2ead322f36100bc1c0fb177af082c`; Gateway manifest `64215489441d571f0b9a52e6051758be60265f4e`; protocol tree `bbc6ebb687118c30d29508771734df754a735b35`. | `passed` |
| Forecast / actual / variance | Total forecast `3.00h`: repo preparation `2.25h`, host proof `0.75h`. Repo preparation actual `1.05h`; variance `-1.20h` (`-53%`). Host actual and total variance remain pending; passive CI/operator waits are excluded. | `repo_passed_host_pending` |
| Repo-preparation result | Local implementation and review evidence passed; exact pushed-head protected evidence remains pending. | `protected_checks_pending` |

Unknown evidence remains `pending`; it is not inferred from a green adjacent
slice or from this document's presence.

### Red-result disposition

- The first local full-Gateway run reached two SQLite-backed files with a
  `better-sqlite3` binary built for Node 22 ABI 127 while the selected Node 24
  process required ABI 137. The allowlisted native dependency was rebuilt
  under Node 24; the affected tests and then the complete 267-test Gateway
  suite passed. This was local dependency state, not product behavior, and
  changed neither a manifest nor the lockfile.
- One independent targeted invocation supplied a nonexistent
  `packages/gateway/vitest.config.ts`; Vitest stopped during startup before any
  test ran. Re-running through the canonical Gateway workspace command passed
  27 files / 267 tests.
- Scope-head [CI 31585382546, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31585382546/attempts/1)
  ran on `AXL-revagent-ci-p02`. Engineering passed; Gateway gates failed in RBP
  shard 2 on `cliAggregate.test.ts` (120 s idle watchdog) and
  `productionBootstrapLauncher.test.ts` (45 s outer watchdog versus the
  child's 30 s attestation timeout), and in shard 3 on
  `productionValidationProvenance.test.ts` (120 s idle watchdog). Shards 1, 4,
  and 5 passed; cardinality remained 61 files / 383 tests / 5 shards. None of
  the failed files is in the M4-02 diff.
- The immediately preceding protected-main [CI 31584904737, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31584904737/attempts/1)
  produced the same three external-watchdog signatures on
  `AXL-revagent-ci-p04`, while Engineering and the same run's unaffected shards
  passed. This parallel p02/p04 reproduction is timing-pressure evidence, not
  a Gateway product-test signature. The standing automatic-rerun permission
  names `productionBootstrapLauncher` but not the other two files, so neither
  run was rerun. `MAINT-01` remains deliberately limited to the planner-bound
  `productionBootstrapLauncher.test.ts` outer-watchdog structure.

### Prepared M4-HOST procedure (not authorized for execution)

After an exact M4-HOST decision, the bounded collector will: retain read-only
pre-state; verify the approved host, LAN/test endpoint/TLS basis, isolated root,
protected-main revision, and immutable image digest; stage only that image;
start it without production tunnel/DNS or credentials; check `/healthz` and the
structured `/mcp` plus `/bridge/v1/**` refusals; stop and remove the temporary
deployment; and retain post-state equality plus a resolvable evidence-bundle
locator. Any selector drift, production-surface dependency, public exposure,
teardown failure, or pre/post inequality stops the procedure.

## M4-HOST evidence collection

**Gate state:** `not_yet_authorized`

No host command, transfer, listener start, container/service mutation, or
remote evidence collection may begin until the operator supplies a decision
specific to M4-HOST. That decision opens only the bounded LAN/test host step;
it does not open any credential, external-client/live, or write-confirm gate.

| Field | Required retained evidence | State |
|---|---|---|
| Operator decision | Exact M4-HOST approval text and its scope ceiling | `not_yet_authorized` |
| Collector | Named collector identity | `not_yet_authorized` |
| Collection time | UTC start/end timestamps | `not_yet_authorized` |
| Host / source / image | Approved test host identity, exact protected-main source revision, and immutable image reference/digest | `not_yet_authorized` |
| Isolated root | Approved test-only root and proof that production roots were not used or changed | `not_yet_authorized` |
| Endpoint / TLS | Exact non-public LAN/test endpoint and approved TLS termination/trust basis | `not_yet_authorized` |
| Pre-run inventory | Bounded listeners, relevant services/containers, test root, and protected production surfaces before execution | `not_yet_authorized` |
| Bounded health execution | Start/health/stop evidence for only the approved immutable production/fail-closed image and endpoint; `/healthz` is the positive image/lifecycle check | `not_yet_authorized` |
| Fail-closed execution | `/mcp` and `/bridge/v1/**` remain structurally unavailable (`503`) in the current image; production-mode refusal is proven without selecting a pre-production runtime | `not_yet_authorized` |
| No public exposure | Proof that no public hostname, DNS route, production tunnel, or public listener was created or activated | `not_yet_authorized` |
| No protected-surface changes | Proof that credentials, production deployment roots, runners, workflows, CD, signing, and NAS surfaces were not changed | `not_yet_authorized` |
| Teardown | Stop/removal evidence for the temporary test deployment and bounded residue check | `not_yet_authorized` |
| Post-run equality | Pre/post equality evidence for the protected surfaces and production service/tunnel state | `not_yet_authorized` |
| Evidence locator | Retained, resolvable evidence-bundle location plus integrity locator | `not_yet_authorized` |
| M4-HOST result | Bounded conclusion with warnings and every red result's root cause | `not_yet_authorized` |

If the approved host, endpoint/TLS basis, exact source/image, or isolation root
is absent or drifts, collection stops without broadening scope. A port
collision, production-surface dependency, public-exposure requirement,
teardown failure, or protected-surface inequality is likewise a stop condition,
not permission to repair infrastructure.

The current image deliberately fixes `NODE_ENV=production`, starts only the
fail-closed ports, and contains no runtime protocol-store adapter. M4-HOST may
therefore prove only its immutable image, lifecycle, health, refusal, isolation,
and teardown properties. The pre-production north + RBP identity flow remains a
repo-local deterministic simulator proof. Adding a pre-production entry point,
promoting a test store, or selecting host runtime credentials is a separately
scoped planner/operator decision; M4-HOST cannot silently authorize it.

## Explicitly open gates and deferred proof

- **M4-CREDENTIAL:** real credential material or credential installation/use
  remains separately operator-gated.
- **M4-CLIENT/LIVE:** external client, real tenant/OAuth flow, live Gateway
  exchange, and live Revit execution remain separately operator-gated.
- **M4-WRITE-CONFIRM:** preview/confirm/write execution against a live target
  remains separately operator-gated.
- **RES-30:** real Gateway token exchange, revoked-device refusal at handshake,
  and device-token persistence across reboot remain unproven. Reboot is not
  authorized by M4-02 or M4-HOST.
- **Production exposure/deployment:** a production tunnel or public DNS route is
  outside M4-02. The self-hosted deploy runner remains deferred to M6; no
  runner, workflow, or CD change is authorized here.

## Submission rule

This ledger stays `in_progress` / `not_submitted` until the bounded repo and
authorized host evidence are complete. A later evidence result does not become
milestone acceptance without the milestone owner's explicit decision.
