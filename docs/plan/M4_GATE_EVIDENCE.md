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

This ledger is limited to the DP-08 dedicated Gateway host and its own numeric
loopback test endpoint. The operator authorized BatchMode SSH discovery, exact
OCI-archive transfer, and native Docker image import/digest verification on
`bt@192.168.90.154` (`revagent`). That preparation is complete. Container
create/start, health/refusal execution, stop/removal, and lifecycle equality
remain separately operator-gated. Credential use, public/LAN bind, DNS or
tunnel changes, Compose or UFW mutation, external/live client execution, live
Revit access, and every write/confirmation action remain closed. Production
deployment, runner, signing, CD, and NAS surfaces remain untouched.

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
| GitHub run and attempt links | Scope head: [Gateway CI 31585382544, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31585382544/attempts/1) passed; [CI 31585382546, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31585382546/attempts/1) passed Engineering but failed the diff-external RBP watchdog family described below. Latest-main integration head `1882289733ff0f3849546443e24d6cedc2c9a2dd`: [Gateway CI 31612776407, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31612776407/attempts/1) and [CI 31612776457, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31612776457/attempts/1) passed. | `passed` |
| Immutable image reference and digest | Exact source `1882289733ff0f3849546443e24d6cedc2c9a2dd` produced OCI archive SHA-256 `13dc7c9ed1edbcf913cd6bec219aefe168bc5ad0173e5632191173e0c0784429`. It was transferred to the DP-08 host and imported by Docker 29.6.2's containerd image store. Engine `Descriptor.digest` and the exact local `tag@digest` selector both resolve `localhost/revagent-gateway:m4-host-1882289733ff@sha256:e6c7e22dfb0cd55cbacbc2c0d1cf8858cd97fd57e8ae98f1ce121dfe7998707b`. No registry publish or container start occurred; the image remains production/fail-closed. | `prepared_remote_lifecycle_pending` |
| Lockfile/protocol/workflow protected-surface equality | No diff in `package-lock.json`, `packages/gateway/package.json`, `packages/protocol/**`, `packages/gateway/src/main.ts`, Gateway Dockerfile, `deploy/**`, or `.github/**`. Base/head blobs: lockfile `b3d8df2755b2ead322f36100bc1c0fb177af082c`; Gateway manifest `64215489441d571f0b9a52e6051758be60265f4e`; protocol tree `bbc6ebb687118c30d29508771734df754a735b35`. | `passed` |
| Forecast / actual / variance | Total forecast `3.00h`: repo preparation `2.25h`, host proof `0.75h`. Repo preparation actual `1.30h`; variance `-0.95h` (`-42%`). Dedicated-host retarget preparation delta: reforecast `0.25h`, actual `0.15h`, variance `-0.10h` (`-40%`). M4-HOST lifecycle actual and total variance remain pending; prior local image-build preparation is retained and will be consolidated at lifecycle closeout. Passive CI/operator waits are excluded. | `repo_passed_host_lifecycle_pending` |
| Repo-preparation result | Local implementation, latest-main integration, independent review, and exact-head protected evidence passed. | `passed` |

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

### Prepared M4-HOST lifecycle (not authorized for execution)

The exact image is now present on the DP-08 host, but no container exists. After
a new exact M4-HOST lifecycle decision, the SSH collector will retain read-only
pre-state; reverify the dedicated host, remote loopback endpoint/TLS basis,
isolated root, source revision, and immutable image digest; create and start
only that image bound to the host's own `127.0.0.1:18080`; check `/healthz` and
the structured `/mcp` plus `/bridge/v1/**` refusals through BatchMode SSH; stop
and remove the temporary container; and retain post-state equality plus a
resolvable evidence-bundle locator. Any selector drift, production-surface
dependency, LAN/public exposure, teardown failure, or pre/post inequality stops
the procedure.

## M4-HOST evidence collection

**Gate state:** `retarget_preparation_complete_lifecycle_not_authorized`

The operator authorized only dedicated-host discovery, archive transfer, and
Docker image import/digest verification. Those steps passed without creating a
container or listener. A new decision is required before container
create/start, health/refusal checks, stop/removal, or lifecycle equality. No
preparation decision opens a credential, external-client/live, write-confirm,
LAN-bind, production-deployment, or tunnel gate.

| Field | Required retained evidence | State |
|---|---|---|
| Operator decision | Retarget authorization allows BatchMode discovery, exact archive transfer, `docker load`, and digest verification only. Lifecycle execution remains separately gated. | `preparation_passed_lifecycle_not_authorized` |
| Collector | `revagent.m4-host.ssh-lifecycle.v1` | `passed_for_preparation` |
| Collection time | Retarget preparation `2026-08-12T20:01:47Z` through `2026-08-12T20:08:38Z`; lifecycle timestamps pending | `passed_for_preparation` |
| Host / source / image | DP-08 host `revagent` (`bt@192.168.90.154`), Ubuntu 26.04 LTS; source `1882289733ff0f3849546443e24d6cedc2c9a2dd`; exact imported ref/digest `localhost/revagent-gateway:m4-host-1882289733ff@sha256:e6c7e22dfb0cd55cbacbc2c0d1cf8858cd97fd57e8ae98f1ce121dfe7998707b` | `passed_for_preparation` |
| Isolated root | `/home/bt/m4-host/PR-370/1882289733ff0f3849546443e24d6cedc2c9a2dd`; owner `bt:bt`, mode `0750`; no production root used | `passed_for_preparation` |
| Endpoint / TLS | `http://127.0.0.1:18080`, the Gateway host's own numeric loopback, probed through SSH; TLS `none`; no trust/proxy mutation. LAN bind is deferred to M4-04. | `passed_for_preparation_lifecycle_pending` |
| Pre-run inventory | BatchMode identity `bt@revagent`; Docker client/server `29.6.2`; containerd image store; zero containers; root filesystem 202 GiB available; TCP 18080/8081 clear; cloudflared disabled/inactive; UFW inactive | `preparation_passed_lifecycle_snapshot_pending` |
| Bounded health execution | Start/health/stop evidence for only the approved immutable production/fail-closed image and endpoint; `/healthz` is the positive image/lifecycle check | `not_yet_authorized` |
| Fail-closed execution | `/mcp` and `/bridge/v1/**` remain structurally unavailable (`503`) in the current image; production-mode refusal is proven without selecting a pre-production runtime | `not_yet_authorized` |
| No public exposure | Preparation opened no listener; cloudflared remained disabled/inactive; TCP 18080 and staged origin 8081 remained clear. No DNS, tunnel, proxy, or LAN bind was created. | `passed_for_preparation_reprove_at_lifecycle` |
| No protected-surface changes | `/opt/revagent/deploy/phase1`'s four root-owned artifacts still match the DP-03-04 SHA-256 values. No credential, UFW, Compose, runner, workflow, CD, signing, or NAS mutation occurred. | `passed_for_preparation_reprove_at_lifecycle` |
| Teardown | Stop/removal evidence for the temporary test deployment and bounded residue check | `not_yet_authorized` |
| Post-run equality | Image import left container inventory at zero and protected preparation surfaces unchanged; full lifecycle pre/post equality remains gated. | `preparation_passed_lifecycle_pending` |
| Evidence locator | Coordinator bundle `C:\Users\BT\AppData\Local\BT-M4-HOST\PR-370\1882289733ff0f3849546443e24d6cedc2c9a2dd\evidence\m4-host-retarget-20260812T200114Z`; remote card mirror `/home/bt/m4-host/PR-370/1882289733ff0f3849546443e24d6cedc2c9a2dd/evidence/m4-host-retarget-20260812T200114Z`; verification-manifest SHA-256 `2d2f95e6490c3c63665d3b5c67504464e1fad90549d7c93c997b2cf47b0620a2` | `passed_for_preparation` |
| M4-HOST result | Exact image preparation on the authoritative host passed. No container lifecycle ran; lifecycle result remains pending a new operator decision. | `remote_image_prepared_lifecycle_pending` |

### Retarget and red-result disposition

- DP-08, not DESKTOP-OKNV128, is authoritative for the Phase-1 Gateway host.
  The locally built source/archive/digest chain remains valid and transportable.
  The local Podman machine `revagent-m4-host` is stopped with an empty container
  inventory and retained; removal is separately gated after M4-02 is green.
- The abandoned local lifecycle collector failed during T0 inventory on a
  PowerShell `String.Replace` overload before any container create/start. No
  local Gateway lifecycle ran.
- SSH discovery attempt 1 proved `bt@revagent` but direct Docker socket access
  was denied, so its chained `docker ps` and `df` did not run. Existing
  noninteractive `sudo -n` authority was used without changing Docker, account,
  or group configuration; attempt 2 passed.
- Docker import returned the exact approved engine descriptor, then an auxiliary
  assertion stopped because it expected `.Id` to be the OCI config digest.
  Docker 29.6.2's containerd image store exposes `.Id` as the manifest digest.
  This was not digest drift: read-only follow-up proved both the tag and exact
  `tag@digest` resolve to `e6c7...`; the archive independently byte-proves the
  `572349...` config descriptor and blob.

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

## Park List

- The production-pruned Gateway image build from exact source
  `1882289733ff0f3849546443e24d6cedc2c9a2dd` reported `2 moderate / 1 high`
  in `npm audit`. This is non-blocking for M4-02/M4-HOST but requires a separate
  planner-bound security disposition before the M5 security/auth lane begins.
  No automatic `npm audit fix` or dependency, manifest, or lockfile mutation was
  authorized or performed. Evidence: `gateway-image-build.log`, SHA-256
  `269f3a10bfe8704773f5c1794774abea1ed79d436a4fb1e51ea3a3b2c03cd66d`.

## Submission rule

This ledger stays `in_progress` / `not_submitted` until the bounded repo and
authorized host evidence are complete. A later evidence result does not become
milestone acceptance without the milestone owner's explicit decision.
