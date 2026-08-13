# M4 Gateway Live-Path Gate Evidence

**Evidence state:** `in_progress`

**Acceptance state:** `not_submitted`

**M4-02 slice state:** `passed`
([`PR #370`](https://github.com/BTankut/revAgent/pull/370) merged as
[`55a34032e9926cfe1c49af932449fc95bc23876c`](https://github.com/BTankut/revAgent/commit/55a34032e9926cfe1c49af932449fc95bc23876c))

**M4-03 slice state:** `in_progress`
([`PR #372`](https://github.com/BTankut/revAgent/pull/372) draft; protected
exact-head evidence pending)

**Plan binding:** `M4-02` is the planner-approved deterministic composition and
bounded-host decomposition of the M4 Gateway live path. `M4-03` is the
operator-approved engineering seam limited to a versioned credential-file
loader and listenerless one-shot validator. Neither slice by itself satisfies
or enlarges the M4 milestone gate.

**M4-02 exact slice base:**
[`42f830ac89e447360a4ebc71120300d5f935fe34`](https://github.com/BTankut/revAgent/commit/42f830ac89e447360a4ebc71120300d5f935fe34)

**M4-03 exact slice base:**
[`55a34032e9926cfe1c49af932449fc95bc23876c`](https://github.com/BTankut/revAgent/commit/55a34032e9926cfe1c49af932449fc95bc23876c)

## Authorization ceiling

The M4-02 host authorization was limited to the DP-08 dedicated Gateway host
and its own numeric loopback test endpoint. The operator first authorized
BatchMode SSH discovery, exact OCI-archive transfer, and native Docker image
import/digest verification on `bt@192.168.90.154` (`revagent`), then separately
authorized the exact-card container lifecycle. The bounded create/start,
health/refusal, stop/removal, residue, and protected-surface equality proof is
complete.

The later M4-03 authorization is repo-only. It permits no real credential,
credential file, host access, stage/use, container execution, or image build.
Credential use, public/LAN bind, DNS or tunnel changes, Compose or UFW
mutation, external/live client execution, live Revit access, and every
write/confirmation action remain closed. Production deployment, runner,
signing, CD, and NAS surfaces remain untouched.

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
| Immutable image reference and digest | Exact source `1882289733ff0f3849546443e24d6cedc2c9a2dd` produced OCI archive SHA-256 `13dc7c9ed1edbcf913cd6bec219aefe168bc5ad0173e5632191173e0c0784429`. It was transferred to the DP-08 host and imported by Docker 29.6.2's containerd image store. Engine `Descriptor.digest` and the exact local `tag@digest` selector both resolve `localhost/revagent-gateway:m4-host-1882289733ff@sha256:e6c7e22dfb0cd55cbacbc2c0d1cf8858cd97fd57e8ae98f1ce121dfe7998707b`. The bounded lifecycle used that exact selector. No registry publish occurred; the image remains production/fail-closed. | `passed` |
| Lockfile/protocol/workflow protected-surface equality | No diff in `package-lock.json`, `packages/gateway/package.json`, `packages/protocol/**`, `packages/gateway/src/main.ts`, Gateway Dockerfile, `deploy/**`, or `.github/**`. Base/head blobs: lockfile `b3d8df2755b2ead322f36100bc1c0fb177af082c`; Gateway manifest `64215489441d571f0b9a52e6051758be60265f4e`; protocol tree `bbc6ebb687118c30d29508771734df754a735b35`. | `passed` |
| Forecast / actual / variance | Original forecast `3.00h`: repo preparation `2.25h`, host proof `0.75h`; dedicated-host retarget added `0.25h`, so revised total forecast is `3.25h`. Repo preparation actual `1.30h`, variance `-0.95h` (`-42%`). Host proof actual `1.05h`: isolated runtime/image preparation `0.80h` (evidence window `18:55:55Z–19:44:55Z`) plus dedicated-host lifecycle closure `0.25h` (`21:00:07Z–21:14:30Z`); against `0.75h`, variance `+0.30h` (`+40%`). Retarget actual `0.15h`; against `0.25h`, variance `-0.10h` (`-40%`). Revised total actual `2.50h`; variance `-0.75h` (`-23%`). Passive CI/operator waits are excluded. | `passed` |
| Repo-preparation result | Local implementation, latest-main integration, independent review, and exact-head protected evidence passed. | `passed` |

Out-of-slice M4 evidence remains `pending`; it is not inferred from a green
adjacent slice or from this document's presence.

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

### Executed M4-HOST lifecycle

The exact-card M4-HOST decision authorized the bounded lifecycle procedure on
the DP-08 host. The SSH collector retained pre-state; reverified the host, remote
loopback endpoint/TLS basis, isolated root, source revision, and immutable image
digest; created and started only that image at `127.0.0.1:18080`; checked the
exact `/healthz`, `/mcp`, and `/bridge/v1/**` response contracts; stopped and
removed the temporary container; and byte-proved the normalized protected
T0/T2 projection. The authoritative attempt is retained under the dual evidence
locator below. No selector drift, production-surface dependency, LAN/public
exposure, teardown failure, or semantic protected-surface inequality remains.

## M4-HOST evidence collection

**Gate state:** `passed_merged`

`PR #370` merged as `55a34032e9926cfe1c49af932449fc95bc23876c`.
Its mandatory merge-push verification passed on
[CI 31652873400, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31652873400/attempts/1)
and
[Gateway CI 31652873401, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31652873401/attempts/1).

The operator separately authorized the exact dedicated-host lifecycle after
discovery, archive transfer, and Docker image import/digest verification had
passed. Lifecycle execution stayed inside that ceiling. Neither decision opens
a credential, external-client/live, write-confirm, LAN-bind,
production-deployment, or tunnel gate.

| Field | Required retained evidence | State |
|---|---|---|
| Operator decision | The exact-card decision allowed only `sudo -n docker` create/start, loopback health/refusal probes, stop/remove, residue, and protected T0/T2 equality. It did not authorize configuration or production-surface repair. | `passed` |
| Collector | `revagent.m4-host.ssh-lifecycle.v1`; authoritative collector script SHA-256 `2ca090cd4f136fd53e9d8c8fdde9f63c5e94dfbab847f94c09f07a11400c4899` | `passed` |
| Collection time | Retarget preparation `2026-08-12T20:01:47Z` through `2026-08-12T20:08:38Z`; authoritative lifecycle `2026-08-12T21:14:12Z` through `2026-08-12T21:14:18Z` | `passed` |
| Host / source / image | DP-08 host `revagent` (`bt@192.168.90.154`), Ubuntu 26.04 LTS; source `1882289733ff0f3849546443e24d6cedc2c9a2dd`; exact imported and executed ref/digest `localhost/revagent-gateway:m4-host-1882289733ff@sha256:e6c7e22dfb0cd55cbacbc2c0d1cf8858cd97fd57e8ae98f1ce121dfe7998707b` | `passed` |
| Isolated root | `/home/bt/m4-host/PR-370/1882289733ff0f3849546443e24d6cedc2c9a2dd`; owner `bt:bt`, mode `0750`; no production root used | `passed` |
| Endpoint / TLS | `http://127.0.0.1:18080`, the Gateway host's own numeric loopback, probed through SSH; TLS `none`; no trust/proxy mutation. LAN bind remains deferred to M4-04. | `passed` |
| Pre-run inventory | BatchMode identity `bt@revagent`; Docker client/server `29.6.2`; containerd image store; zero containers and volumes; no network attachments; TCP 18080/8081 clear; cloudflared disabled/inactive; UFW inactive | `passed` |
| Bounded health execution | Container `revagent-m4-host-pr370-1882289733ff` (`ddd37c1d794d4de234457e9442aa3509f5a7faa7e09c06d96b6c5aeb1421f330`) used read-only rootfs, `/tmp` tmpfs, all capabilities dropped, no-new-privileges, bounded PID/memory, no bind mounts, and only `127.0.0.1:18080 -> 8080/tcp`. `GET /healthz` returned exact HTTP `200` body `{"status":"ok"}`. | `passed` |
| Fail-closed execution | `POST /mcp` returned structured HTTP `503` with `port=north_mcp`; `POST /bridge/v1` and `/bridge/v1/m4-host-proof` returned structured HTTP `503` with `port=rbp_ingress` and the exact reserved-path message. No credential or pre-production runtime was selected. | `passed` |
| No public exposure | During T1 the only host listener was numeric loopback `127.0.0.1:18080`; TCP 8081 stayed clear. After removal both ports were clear. Cloudflared stayed disabled/inactive; no DNS, tunnel, proxy, UFW, Compose, or LAN bind was created. | `passed` |
| No protected-surface changes | `/opt/revagent/deploy/phase1`'s four root-owned artifacts retained the DP-03-04 SHA-256 values. Docker config, cloudflared files/service, account/group, isolated-root non-evidence files, Docker logical inventories, normalized IPv4/IPv6 firewall rule graphs, and host anchors were equal at T0/T2. No credential, runner, workflow, CD, signing, or NAS mutation occurred. | `passed` |
| Teardown | `docker stop --timeout 10` produced `Status=exited`, `ExitCode=0`, `OOMKilled=false`, empty `Error`, and no `gateway.shutdown_failed`; non-force remove succeeded. Exact-name and all-container counts are zero. | `passed` |
| Post-run equality | Fifteen protected facets passed T0/T2 equality; exact container, all-container, network-attachment, volume, and target-listener residue is zero. | `passed` |
| Evidence locator | Authoritative coordinator bundle `C:\Users\BT\AppData\Local\BT-M4-HOST\PR-370\1882289733ff0f3849546443e24d6cedc2c9a2dd\evidence\m4-host-lifecycle-20260812T211328Z`; remote mirror `/home/bt/m4-host/PR-370/1882289733ff0f3849546443e24d6cedc2c9a2dd/evidence/m4-host-lifecycle-20260812T211328Z`; 60/60 files reverified locally and remotely; `verification-manifest.tsv` SHA-256 `5a6e18c82535643b74d39fe1771c1691be08be40ac6f014102bfee97a24a1c43` | `passed` |
| M4-HOST result | Exact immutable image lifecycle, positive health, structured fail-closed refusal, graceful teardown, residue, and protected-surface equality passed on the authoritative host. | `passed` |

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
- Lifecycle attempt `m4-host-lifecycle-20260812T210007Z` stopped during T0
  before create because empty default Docker networks emitted blank lines into
  the attachment inventory. Filtering blank rows fixed the evidence harness;
  container and target-listener residue remained zero.
- Attempt `...T210852Z` also stopped during T0 before create because GNU
  `stat -c` retained literal `\n` sequences in one owner/group/mode line. Three
  explicit lines fixed the harness; residue remained zero.
- Attempt `...T210917Z` created and started the exact image and proved
  `/healthz` `200`, then stopped on a collector-only `docker port` format
  assumption. Emergency stop/remove passed. The expected output is
  `8080/tcp -> 127.0.0.1:18080`, not a bare host endpoint.
- Attempt `...T211042Z` passed all four HTTP checks and graceful removal, then
  stopped because the firewall comparator retained `iptables-save` timestamps
  and live traffic counters. The other thirteen facets were byte-equal; IPv4
  and IPv6 rule/chain/policy projections were equal after removing only those
  volatile fields. The authoritative comparator keeps semantic rules while
  excluding timestamps and counters.
- Attempt `...T211229Z` passed behavior and equality but was rejected as the
  authoritative package: sourcing `/etc/os-release` had overwritten the generic
  shell variable `NAME`, so the temporary container was called `Ubuntu`. It was
  removed cleanly; the same latent naming collision affected the two earlier
  created-container attempts, which were also removed. The final collector
  isolates os-release reads, uses `CONTAINER_NAME`, and asserts the exact
  deterministic name before start.
- Authoritative attempt `...T211328Z` passed without fallback. Its first
  manifest was then regenerated after the asynchronous transcript writer had
  flushed; the final manifest verifies all 60 retained files and is the only
  manifest cited above.

If the approved host, endpoint/TLS basis, exact source/image, or isolation root
is absent or drifts, collection stops without broadening scope. A port
collision, production-surface dependency, public-exposure requirement,
teardown failure, or protected-surface inequality is likewise a stop condition,
not permission to repair infrastructure.

The current image deliberately fixes `NODE_ENV=production`, starts only the
fail-closed ports, and contains no runtime protocol-store adapter. M4-HOST may
therefore prove only its immutable image, lifecycle, health, refusal, isolation,
and teardown properties. M4-03/A adds a standalone repo-local validator only;
it deliberately refuses `NODE_ENV=production`. Image/default-CMD/runtime
selection, a new build and digest, credential stage/use, and any promoted store
remain M4-CREDENTIAL/B work under a separate operator card. M4-HOST cannot
silently authorize them.

## M4-03 engineering-seam evidence

**Gate state:** `implementation_complete_protected_evidence_pending`

| Field | Evidence | State |
|---|---|---|
| Authorization / scope | Operator-approved A only: versioned credential-file loader plus listenerless one-shot validator on protected `main@55a34032`. No real credential, host access, stage/use, container, or image build. | `passed` |
| Contract and physical policy | `revagent.m4-preproduction-credentials/v1`; exact `lan_test` / `preproduction`; bounded independent visible-ASCII fields; canonical current-user POSIX regular file; exact `0400`; one hard link; pre/post canonical path and descriptor-state checks. Windows actual loading fails closed. | `passed` |
| Value-free and synthetic-fixture proof | All new secret fixtures use fixed recognizable `SYNTHETIC-...` canaries. Loader and validator tests scan complete values and distinguishing fragments across exception, stack, own properties, injected evidence, ambient stdout/stderr, and console paths, including forged typed errors and a real loader-to-validator refusal. | `passed` |
| Listenerless / production refusal | The real bundled main is subprocess-tested for exact exit/output behavior and a server/store/composition-free import graph. Ambient `NODE_ENV=production` returns a value-free exit `78` before file access. | `passed` |
| Local evidence | Node `v24.19.0`: targeted 2 files / 15 tests passed, with 1 additional real-POSIX smoke skipped only on Windows; Gateway lint, type-check, build, and full 29 files / 282 tests passed, with the same platform-specific smoke skipped. Handler manifest remained `sha256:cb193dc22716e12217edc4f5516c7145eb6e42a488c6360777b01e977644ecde`. | `passed` |
| Independent review | Three salt-read-only reviews found no remaining P0-P2 source or scope issue after production-refusal, value-free-output, typed-error, exact-mode, path-race, import-graph, and evidence fixes. | `passed` |
| Protected exact-head runs | Pending implementation push. Scope-head runs are not implementation evidence. | `pending` |
| Protected-surface equality | No diff from `55a34032` in root lockfile; Gateway package manifest, Dockerfile/default CMD, production `main.ts`, public `index.ts`, `config.ts`, `server.ts`, `store.ts`, `testAdapters.ts`; protocol; deploy; or workflows. | `passed` |
| Image / credential operation | Not performed. New image build/digest and every credential stage/use action are explicitly deferred to the separate M4-CREDENTIAL/B card after A merges. | `passed` |
| Forecast / actual / variance | Forecast `1.50h`; actual and variance close after exact-head protected evidence. Passive CI/operator waits excluded. | `pending` |
| Result | Repo-local implementation and local proof passed; protected exact-head evidence remains required before planner merge review. | `pending` |

### M4-03 local red-result disposition

- The first full-Gateway invocation used an incomplete borrowed dependency tree
  and stopped before product tests. Installing the exact locked dependencies in
  the isolated worktree and rebuilding the allowlisted `better-sqlite3` native
  module for Node 24 restored the intended environment; targeted and full
  Gateway tests then passed. No manifest or lockfile changed.

## Explicitly open gates and deferred proof

- **M4-CREDENTIAL:** a new exact-source image build/digest, real credential
  material, and credential installation/use remain separately operator-gated.
- **M4-CLIENT/LIVE:** external client, real tenant/OAuth flow, live Gateway
  exchange, and live Revit execution remain separately operator-gated.
- **M4-WRITE-CONFIRM:** preview/confirm/write execution against a live target
  remains separately operator-gated.
- **RES-30:** real Gateway token exchange, revoked-device refusal at handshake,
  and device-token persistence across reboot remain unproven. Reboot is not
  authorized by M4-02, M4-HOST, or M4-03/A.
- **Production exposure/deployment:** a production tunnel or public DNS route is
  outside M4-02 and M4-03/A. The self-hosted deploy runner remains deferred to
  M6; no runner, workflow, or CD change is authorized here.

## Park List

- The production-pruned Gateway image build from exact source
  `1882289733ff0f3849546443e24d6cedc2c9a2dd` reported `2 moderate / 1 high`
  in `npm audit`. This is non-blocking for M4-02/M4-HOST but requires a separate
  planner-bound security disposition before the M5 security/auth lane begins.
  No automatic `npm audit fix` or dependency, manifest, or lockfile mutation was
  authorized or performed. Evidence: `gateway-image-build.log`, SHA-256
  `269f3a10bfe8704773f5c1794774abea1ed79d436a4fb1e51ea3a3b2c03cd66d`.

## Submission rule

M4-02's bounded repo and authorized-host evidence is complete, the slice is
`passed`, and `PR #370` merged as `55a34032`. M4-03/A remains draft in `PR #372`
until exact-head protected evidence passes and the planner grants merge
approval. The M4 milestone ledger stays `in_progress` / `not_submitted` because
M4-CREDENTIAL, M4-CLIENT/LIVE, M4-WRITE-CONFIRM, and the remaining
planner-bound slices are still open. No evidence result becomes milestone
acceptance without the milestone owner's explicit decision.
