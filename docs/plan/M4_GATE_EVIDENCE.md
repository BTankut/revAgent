# M4 Gateway Live-Path Gate Evidence

**Evidence state:** `in_progress`

**Acceptance state:** `not_submitted`

**M4-02 slice state:** `passed`
([`PR #370`](https://github.com/BTankut/revAgent/pull/370) merged as
[`55a34032e9926cfe1c49af932449fc95bc23876c`](https://github.com/BTankut/revAgent/commit/55a34032e9926cfe1c49af932449fc95bc23876c))

**M4-03 slice state:** `passed_merged`
([`PR #372`](https://github.com/BTankut/revAgent/pull/372) merged as
[`9b7ead1396ac080ea90bf2923bd1ebe871847f3f`](https://github.com/BTankut/revAgent/commit/9b7ead1396ac080ea90bf2923bd1ebe871847f3f))

**M4-CREDENTIAL/B gate state:** `passed`

**M4-04/A slice state:** `passed_merged`
([`PR #375`](https://github.com/BTankut/revAgent/pull/375) merged as
[`6aa04593657fa2e3ee8a656ff97b553daf07f29e`](https://github.com/BTankut/revAgent/commit/6aa04593657fa2e3ee8a656ff97b553daf07f29e))

**M4-04 Gate 1 state:** `completed_with_blocker`

**M4-04/A2 slice state:** `scope_recorded`
(draft PR pending)

**Plan binding:** `M4-02` is the planner-approved deterministic composition and
bounded-host decomposition of the M4 Gateway live path. `M4-03/A` is the
operator-approved repo seam limited to a versioned credential-file loader and
listenerless one-shot validator. `M4-CREDENTIAL/B` is the separately authorized
exact-source target-host proof of one native Linux credential load plus cleanup.
`M4-04/A` is the separately authorized repo-only pre-production serving seam;
it prepares no host, DNS, trust, credential, container, client, or Revit
operation. Gate 1 is the planner-authorized read-only PETRUCCI placement and
client-feasibility inspection. `M4-04/A2` is the separately authorized
repo-only credential generation and two-host secret-handoff seam. None of
these bounded slices by itself satisfies or enlarges the M4 milestone gate.

**M4-02 exact slice base:**
[`42f830ac89e447360a4ebc71120300d5f935fe34`](https://github.com/BTankut/revAgent/commit/42f830ac89e447360a4ebc71120300d5f935fe34)

**M4-03 exact slice base:**
[`55a34032e9926cfe1c49af932449fc95bc23876c`](https://github.com/BTankut/revAgent/commit/55a34032e9926cfe1c49af932449fc95bc23876c)

**M4-CREDENTIAL/B exact source:**
[`9b7ead1396ac080ea90bf2923bd1ebe871847f3f`](https://github.com/BTankut/revAgent/commit/9b7ead1396ac080ea90bf2923bd1ebe871847f3f)

**M4-04/A exact slice base:**
[`bfc21873370891a544c11494f8888fd077136b55`](https://github.com/BTankut/revAgent/commit/bfc21873370891a544c11494f8888fd077136b55)

**M4-04/A2 exact slice base:**
[`6aa04593657fa2e3ee8a656ff97b553daf07f29e`](https://github.com/BTankut/revAgent/commit/6aa04593657fa2e3ee8a656ff97b553daf07f29e)

## Authorization ceiling

The M4-02 host authorization was limited to the DP-08 dedicated Gateway host
and its own numeric loopback test endpoint. The operator first authorized
BatchMode SSH discovery, exact OCI-archive transfer, and native Docker image
import/digest verification on `bt@192.168.90.154` (`revagent`), then separately
authorized the exact-card container lifecycle. The bounded create/start,
health/refusal, stop/removal, residue, and protected-surface equality proof is
complete.

The M4-03/A authorization was repo-only. It permitted no real credential,
credential file, host access, stage/use, container execution, or image build.
After A merged, the operator separately authorized the exact M4-CREDENTIAL/B
card: exact-source image import, one ephemeral pre-production credential file,
one listenerless validator container with `--network none`, and mandatory
cleanup/equality proof on the DP-08 host. B did not authorize Gateway start,
public/LAN bind, DNS or tunnel changes, Compose or UFW mutation, external/live
client execution, live Revit access, enrollment/revoke, reboot, or any
write/confirmation action. Production deployment, runner, signing, CD, and NAS
surfaces remained untouched.

The pre-production composition must remain explicit and fail closed: no
production-mode bypass, no implicit credentials, no second identity path, and
no claim that deterministic identity fixtures prove real OAuth or device-token
durability.

The M4-04/A authorization is likewise repo-only. The operator bound the three
logical endpoints to two physical machines: Gateway is `revagent`, while the
WP9 client, Bridge, add-in, and Revit are all on `PETRUCCI`.
`DESKTOP-OKNV128` is not an M4 client. This placement decision does not prove an
active client session, a current Revit document, or any live path.

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
it deliberately refuses `NODE_ENV=production`. M4-HOST and M4-03/A deferred the
new build/digest and credential stage/use to a separate operator card; that
bounded M4-CREDENTIAL/B proof is now complete below. No Gateway runtime/store
selection or start occurred, no store was promoted, and neither earlier slice
silently authorized B or an adjacent gate.

## M4-03 engineering-seam evidence

**Gate state:** `passed_merged`

| Field | Evidence | State |
|---|---|---|
| Exact implementation head | [`00a9e560248cfaed97138e1668f70cc69c436683`](https://github.com/BTankut/revAgent/commit/00a9e560248cfaed97138e1668f70cc69c436683); tree `ff49667dd90d8139f4e030c3e6fd0ab396424237`. | `passed` |
| Changed-path inventory | Seven paths: five new `packages/gateway/src/preProductionCredential*` implementation/test files plus the Gateway README and this M4 ledger; 2,057 insertions / 33 deletions. | `passed` |
| Authorization / scope | Operator-approved A only: versioned credential-file loader plus listenerless one-shot validator on protected `main@55a34032`. No real credential, host access, stage/use, container, or image build. | `passed` |
| Contract and physical policy | `revagent.m4-preproduction-credentials/v1`; exact `lan_test` / `preproduction`; bounded independent visible-ASCII fields; canonical current-user POSIX regular file; exact `0400`; one hard link; pre/post canonical path and descriptor-state checks. Windows actual loading fails closed. | `passed` |
| Value-free and synthetic-fixture proof | All new secret fixtures use fixed recognizable `SYNTHETIC-...` canaries. Loader and validator tests scan complete values and distinguishing fragments across exception, stack, own properties, injected evidence, ambient stdout/stderr, and console paths, including forged typed errors and a real loader-to-validator refusal. | `passed` |
| Listenerless / production refusal | The real bundled main is subprocess-tested for exact exit/output behavior and a server/store/composition-free import graph. Ambient `NODE_ENV=production` returns a value-free exit `78` before file access. | `passed` |
| Local evidence | Node `v24.19.0`: targeted 2 files / 15 tests passed, with 1 additional real-POSIX smoke skipped only on Windows; Gateway lint, type-check, build, and full 29 files / 282 tests passed, with the same platform-specific smoke skipped. Handler manifest remained `sha256:cb193dc22716e12217edc4f5516c7145eb6e42a488c6360777b01e977644ecde`. | `passed` |
| Independent review | Three salt-read-only reviews found no remaining P0-P2 source or scope issue after production-refusal, value-free-output, typed-error, exact-mode, path-race, import-graph, and evidence fixes. | `passed` |
| Protected exact-head runs | Exact implementation head: [Gateway CI 31671674694, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31671674694/attempts/1) passed; [CI 31671674559, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31671674559/attempts/1) passed both Engineering and Gateway gates. Final PR head `bf6a6be0f6caf286f161036f0c2f99e630952adc`: [Gateway CI 31673749478, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31673749478/attempts/1), [CI 31673749475, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31673749475/attempts/1), and [Claude review 31677066523, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31677066523/attempts/1) passed. GitGuardian passed. No rerun. Scope-head runs are not implementation evidence. | `passed` |
| Protected merge / merge-push | `PR #372` merged as [`9b7ead1396ac080ea90bf2923bd1ebe871847f3f`](https://github.com/BTankut/revAgent/commit/9b7ead1396ac080ea90bf2923bd1ebe871847f3f). Merge-push [CI 31677260832, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31677260832/attempts/1) passed Engineering and Gateway gates; [Gateway CI 31677260849, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31677260849/attempts/1) passed. No rerun. | `passed` |
| Protected-surface equality | No diff from `55a34032` in root lockfile; Gateway package manifest, Dockerfile/default CMD, production `main.ts`, public `index.ts`, `config.ts`, `server.ts`, `store.ts`, `testAdapters.ts`; protocol; deploy; or workflows. | `passed` |
| Image / credential operation | Not performed under A. The later exact-source image build and separately authorized M4-CREDENTIAL/B target-host operation are recorded below; they do not retroactively enlarge A. | `passed` |
| Forecast / actual / variance | Forecast `1.50h`; actual `0.75h`; variance `-0.75h` (`-50%`). Passive CI/operator waits excluded. | `passed` |
| Result | Repo-local implementation, local proof, three independent reviews, final-head protected/Claude evidence, protected merge, and merge-push verification passed. | `passed` |

### M4-03 local red-result disposition

- The first full-Gateway invocation used an incomplete borrowed dependency tree
  and stopped before product tests. Installing the exact locked dependencies in
  the isolated worktree and rebuilding the allowlisted `better-sqlite3` native
  module for Node 24 restored the intended environment; targeted and full
  Gateway tests then passed. No manifest or lockfile changed.

## M4-CREDENTIAL/B target-host evidence

**Gate state:** `passed`

The operator separately approved the complete card values and a maximum of one
bounded validator attempt. The exact-source image was imported on the DP-08
Gateway host; ephemeral pre-production material was created there, loaded once
under native Linux `0400`, and removed. This is credential-seam proof only. It
does not prove a tenant/OAuth exchange, enrollment/revocation, reboot
persistence, external-client conformance, live Revit, or write confirmation.

| Field | Required retained evidence | State |
|---|---|---|
| Operator decision | Exact card: `revagent` (`bt@192.168.90.154`), source `9b7ead1396ac080ea90bf2923bd1ebe871847f3f`, immutable image `localhost/revagent-gateway:m4-credential-9b7ead1396ac@sha256:66f0eb1d0eb4eb9c571823ad820275c1eb2c419a4a81da170a66037ef009772f`, isolated root `/home/bt/m4-credential/PR-372/9b7ead1396ac080ea90bf2923bd1ebe871847f3f`, collector `revagent.m4-credential.ssh-oneshot.v1`. Maximum scope was read-only staging, one listenerless validation, and mandatory cleanup. | `passed` |
| Exact build chain | Source archive SHA-256 `6bef0792d959d95942313350fcea4bd09ffeff08f34ddbfd629188c2f794a9d7`; Dockerfile SHA-256 `3a8957010d0458925397fb7daa704f0ba4f514e00fd239b4613b164525adfb03`; build-log SHA-256 `0b113c3352dfe248637bbc2127032fbb692eb69d3414d5cf5123cd7834270841`; OCI archive SHA-256 `561b3c9250ca2dbbfeadff70d8fcd16a8cbbdcaca3fcf8610ea7f93ff89dc65b`; OCI/engine manifest digest `sha256:66f0eb1d0eb4eb9c571823ad820275c1eb2c419a4a81da170a66037ef009772f`. The build-stage boot smoke was local build evidence only; the target-host normal Gateway command did not execute. No registry publish occurred. | `passed` |
| Collector / bounded invocation | Collector script SHA-256 `ba7139b69749cceebcd0af279e8256df1692025396380c1fdb267938d312f60a`; one and only one `docker run`, `2026-08-13T08:48:53Z–08:48:59Z` (`6` seconds), with live host `UID:GID 1000:1000`, `--network none`, read-only root filesystem, direct read-only file bind, all capabilities dropped, no-new-privileges, bounded PID/memory, `NODE_ENV=preproduction`, and explicit `node /app/packages/gateway/dist/preProductionCredentialValidatorMain.js`. | `passed` |
| Linux credential policy / result | The target-host file was `bt:bt`, canonical regular file, exact mode `0400`, `nlink=1`, bounded size `368` bytes. The native loader returned exit `0` and exactly one success object: action `validate_preproduction_credential_file`, contract `revagent.m4-preproduction-credentials/v1`, `lan_test`, `preproduction`, `posix-owner-read-only-0400`, and `northCredentialCount=1`. Validator stderr was empty. | `passed` |
| Value-free evidence | Three independent ephemeral values were generated and held transiently in the host shell process, written only to the bounded credential file, and piped in memory to the scanner; they were never emitted to argv, environment, stdout, stderr, transcript, or retained evidence. The complete pass/fail evidence tree was scanned against every contiguous 10-character distinguishing fragment before packaging; it passed. No body, hash, or fragment is retained in evidence. The file was unlinked; secure erase of filesystem blocks is not claimed. | `passed` |
| Positive cleanup / residue | The credential was explicitly unlinked and then separately observed absent. The exact isolated root was removed and then separately observed absent. The `finally` path independently recorded credential/root/container absence. A fresh post-package SSH probe again returned credential/root/container absent, `0` attempt processes, `0` attempt mounts, `0` containers, and `0` volumes. The immutable image is the sole retained delta. | `passed` |
| Protected-surface equality | Fifteen pre/post facets matched: host/service anchors; container, volume, network, attachment, process, mount, and listener inventories; normalized IPv4/IPv6 firewall rules; Phase-1 deploy artifacts; cloudflared and Docker configuration; account/group. No image was removed; the single addition was the exact approved tag/digest. | `passed` |
| Evidence locator / integrity | Coordinator evidence: `C:\Users\BT\AppData\Local\BT-M4-CREDENTIAL\PR-372\9b7ead1396ac080ea90bf2923bd1ebe871847f3f\execution-20260813T082824Z`. The extracted bundle has 51/51 verified manifest entries; manifest SHA-256 `abc7e54bf4e6da53d9aff39ed1d397d60a3ddfff9459dc8c3e093e2f30fb8b58`; compressed evidence SHA-256 `6ae6163993bc5bd4a680396ef02df885228e79ddad0dc28ce887919cd8dc5b44`. The remote isolated root is intentionally absent after cleanup. | `passed` |
| Forecast / actual / variance | Forecast `0.75h`; actual `0.36h` active execution and verification effort; variance `-0.39h` (`-52%`). Passive waits excluded. | `passed` |
| Result | Exact immutable image import, one native Linux `0400` credential load, exact value-free validator output, positive unlink/root removal, zero credential/root/container/transient residue, and protected-surface equality passed without rerun. The exact image is the sole permitted retained delta. | `passed` |

### M4-CREDENTIAL/B preparation disposition

- A first coordinator root-preparation call stopped in local PowerShell quoting;
  no remote command ran, and a read-only follow-up proved the root absent.
- The literal remote preparation then created the final `image` directory but
  left its intermediate parent at inherited mode `0775`; the exact-mode
  assertion stopped before archive transfer, credential creation, image load,
  or container execution. The attempt-owned root was changed to `0700` and
  reverified before transfer. These preparation stops are not validator
  attempts; the authorized bounded validator count remained exactly one.
- Two independent pre-execution script audits initially returned no-go on
  failure-path ownership, full-tree secret-fragment scanning, and process/mount
  residue coverage. The collector was corrected and both audits returned GO on
  exact script SHA-256 `ba7139...` before host credential or container work.

## M4-04/A repo-only engineering seam

**Gate state:** `passed_merged`

M4-04/A is limited to the explicit `lan_test` / `preproduction` Gateway serving
seam, deterministic tests, caller-supplied live-smoke target parameters, and
the directly related plan and decision records. It may prepare the strict
real-Gateway enrollment and revoked-device refusal seams in code, but it does
not perform a real exchange, create or stage a credential, start a Gateway,
connect a client, or contact Revit. RES-30 therefore remains open, including
device-token persistence across reboot.

The engineering acceptance scope requires the M4-03 credential loader to feed
one identity/store/Bridge/north graph, a strict `POST /bridge/v1/enroll` seam,
deterministic selected-session routing, revoked-device and value-free negative
tests, and an unchanged production fail-closed default. The three executable
residuals are `scripts/invoke-live-smoke-over-ssh.ps1`,
`packages/gateway/scripts/gw13-live-smoke.mjs`, and
`packages/gateway/scripts/run-gw13-readiness.mjs`; live execution must receive
its target from the caller and must not default to NET01 or PETRUCCI. Root
lockfile churn is outside the slice and is a stop condition.

The production naming and connector authority already exists and is not an
M4 discovery item:

- [`DP-04`](../decisions/DP-04-domain.md) confirms the canonical production
  origin `gateway.revagent.app` and forbids configuring clients with an IP
  address or machine hostname.
- [`DP-03/DP-04 staging evidence`](../decisions/DP-03-04-cloudflare-staging.md)
  records the existing production tunnel and its
  `gateway.revagent.app -> http://127.0.0.1:8081` ingress. The connector remains
  deliberately stopped and is not started by M4.

The M4 test approach is a separate same-zone test FQDN with a DNS-only private
`A` record to `192.168.90.154` and a publicly trusted certificate to be
obtained by DNS-01. The name may resolve publicly, but its private target is not
publicly routable. The test label is only a candidate until the separate
`DNS/TLS-TRUST` card binds its exact FQDN and certificate details; no DNS record
or certificate exists by virtue of this repo seam. The Cloudflare token also
requires its own operator gate. It must be supplied out of band, limited to DNS
edit for the relevant zone, excluded from git, PRs, CI, logs, and evidence, and
given an explicit post-use revoke, rotate, or retained-custody disposition in
that card. If the approved narrow scope cannot support the DNS-01 client, work
stops for operator/planner disposition rather than silently broadening access
or installing local trust.

The serving process and the later Docker publish are two different bind
surfaces. Inside the image, pre-production requires an explicit
`GATEWAY_BIND_HOST=0.0.0.0`; loopback and omitted values fail closed, and the
host's LAN address is not valid inside the container namespace. The separate
`NETWORK/ACL` card must bind Docker's host publish specifically to
`192.168.90.154` and prove the approved exposure. This engineering seam opens
neither listener.

The seven M4-04/B records/gates remain distinct:
`CLIENT-PLACEMENT/FEASIBILITY`, `NETWORK/ACL`, `DNS/TLS-TRUST`,
`BRIDGE-STAGE`, `CREDENTIAL/ENROLL`, `CLIENT/LIVE`, and
`CLEANUP/RESIDUE-EQUALITY`. The placement decision is now bound to PETRUCCI,
but its active-session feasibility proof and the other six execution gates
remain open. The later `M4-WRITE-CONFIRM` gate also remains separately closed.
M4-04/A authorizes none of those operations.

The protected implementation merged in [PR #375](https://github.com/BTankut/revAgent/pull/375)
as [`6aa04593657fa2e3ee8a656ff97b553daf07f29e`](https://github.com/BTankut/revAgent/commit/6aa04593657fa2e3ee8a656ff97b553daf07f29e).

## M4-04 Gate 1 — PETRUCCI client-placement feasibility

**Gate state:** `completed_with_blocker`

The planner authorized one read-only collection from `DESKTOP-OKNV128` to
`ws2@192.168.90.122`. The collection ran on 2026-08-13 between
`17:55:52Z` and `18:05:58Z` with BatchMode and strict host-key checking. It did
not edit a file, start/stop a service, open a model, invoke the Revit MCP
runtime, add an MCP registration, contact `revagent` from PETRUCCI, or exercise
any later M4-04/B gate.

| Surface | Read-only evidence | Disposition |
|---|---|---|
| Host/session | `petrucci\ws2` on `PETRUCCI`; console session 1 was `Active`. | placement identity passed |
| Codex Desktop | AppX `OpenAI.Codex` `26.803.10989.0` was `Ok`; `ChatGPT.exe` and its child `codex.exe` ran as `PETRUCCI\ws2` in session 1. The user auth artifact existed and was updated that day, but its contents were not read; process plus artifact presence is not accepted as proof of a valid signed-in account. | active local process passed; signed-in state unproven |
| Remote-MCP registration | The installed user's `~\.codex\config.toml` existed with two MCP sections. Its value-free shape contained one `command` key and no `url`, `bearer_token_env_var`, `http_headers`, or `env_http_headers` key. Current Codex documentation supports Streamable HTTP with bearer-token environment variables or OAuth, but the live PETRUCCI build has no configured remote server and no arbitrary static-bearer secure-store import was found. | transport is product-supported; required no-env/no-plain-config bearer sink blocked |
| Call origin | The running PETRUCCI Codex process tree was observed. No connection to `192.168.90.154` existed and no request was sent. A future direct remote-MCP or local-broker route would originate on PETRUCCI, but live origin remains unproven until `CLIENT/LIVE`. | prospective origin resolved; live origin unproven |
| Revit/add-in | Revit 2022 process `4760` ran as `PETRUCCI\ws2`; its add-in listener was active on `127.0.0.1:8080`. Add-in manifest SHA-256 `9aa1ea865289adc352d5ad467fec93c11ff48b10f15f5c40bc5348d036f95b6c` and DLL SHA-256 `1e25e5a3eaaaad420a98e45abc511a11ab6ba0d9c62875650010b91c7433aefa` retained their earlier protected-main match. SSH did not identify the open document. | runtime surface present; current model unproven |
| Bridge | `revAgentBridge` remained `Running` / `Auto` / `LocalSystem`; host and worker processes ran as SYSTEM. Configuration still named `wss://localhost:8443/bridge/v1`; the M3 stub listened on loopback `8443`; no Bridge TCP connection was present. Credential artifacts were inventoried by path/size only and never read. | installed M3 surface present; real-Gateway enrollment absent |
| Model candidate | `C:\Program Files\Autodesk\Revit 2022\Samples\rme_basic_sample_project.rvt` existed at 30,482,432 bytes with SHA-256 `701e419b1f566c46bff51bb75f033d219719e593c47cfb2bb3548b6e8137fa51`. | exact candidate accessible; opening remains `CLIENT/LIVE` |

One optional binary-capability string scan exceeded its 60-second bound and
produced no evidence. Its exact read-only PowerShell process was found by PID,
terminated as attempt-owned cleanup, and then positively observed absent. No
application/configuration state changed; the scan is excluded from every
capability claim above.

Gate 1 therefore validates the chosen two-machine placement but does not open
`CLIENT/LIVE`: the static north bearer has no approved client sink. An
environment variable would violate the card's no-env requirement, a literal
header would persist the secret in plain configuration, and `auth.json`
existence is not an API for importing an arbitrary MCP bearer. A separate
planner decision would be required for a local DPAPI-backed stdio broker or a
different client-auth route.

## M4-04/A2 secret-generation and two-host-handoff seam

**Gate state:** `scope_recorded`

**Scope of record:** protected source is
`6aa04593657fa2e3ee8a656ff97b553daf07f29e`. This repo-only slice owns one
OS-CSPRNG generator for the three M4 pre-production credential fields, a
bounded binary two-host handoff for the allowlisted `north_bearer` and
`enrollment_artifact` classes, a PowerShell 5.1 destination receiver, and
deterministic tests for success, refusal, timeout/failure cleanup, and
value-free output. Secret fixtures use a recognizable `SYNTHETIC-...` prefix.
The slice uses only existing platform libraries; root lockfile churn is a stop
condition.

The generator must produce three independent 48-byte values; create only an
exclusive, canonical, owner-bound POSIX `0400` file below exact `0700`
ancestors; sync and close its handle; validate it through the existing
listenerless M4-03 loader; and positively prove absence after any owned failure.
The handoff must keep secret bytes off argv, environment, transcript, log, and
evidence surfaces; enforce closed secret classes and byte bounds; use binary
streams rather than PowerShell text pipelines; share one bounded deadline; and
positively verify owned source/destination cleanup on every failure.

Gate 1 constrains the destination behavior. `enrollment_artifact` may reach one
protected Windows file consumer. `north_bearer` must return the fixed
value-free refusal `client_secure_store_unavailable` until a separately
planner-bound Codex consumer exists; A2 must still drain/clean both logical
handoff sides in that negative case. Green A2 evidence cannot be cited as a
Codex registration, client credential stage, live handoff, or permission for
Gate 2–7.

**Explicitly out:** real secret generation, either live host, SSH execution,
credential or Bridge staging, Codex configuration/auth mutation, Gateway or
container start, DNS/TLS/UFW/Compose, Revit/model operation, enrollment/revoke,
reboot, external client, write/confirm, production origin/tunnel, workflow,
runner, CD/signing, and NAS. A new exact-source image is deferred until A2
merges because Gateway build-context bytes will change.

**Forecast:** `1.75h` active effort, calibrated from the prior M2 `-72%`
variance. Passive CI/review waits are excluded. Actual and variance are filled
only after implementation and protected evidence.

## M4-04/A3 observer disposition

**Decision requested from planner:** `bind A3`

The current Bridge cannot close RES-30's revoked-device evidence using only a
Gateway-side value-free `4403` record plus existing PETRUCCI logs. Gateway can
prove that it refused the handshake, and Bridge code maps `4403` to
`Authorization`, then `Auth`, then `RetryPaused/Auth`; however, that final
state exists only in the coordinator's internal snapshot. Normal worker logs
do not emit it and `doctor` performs DNS/TCP checks rather than an RBP
handshake. The missing live observation is: the same PETRUCCI worker received
the correlated `4403`, classified it as authorization failure, entered
`RetryPaused/Auth`, and remained paused. Absence of another handshake cannot
distinguish that state from transport loss or a stalled worker.

A3's minimum repo scope is a value-free Gateway refusal correlation plus a
value-free Bridge `RetryPaused/Auth` observer. Any Bridge binary stage remains
outside A3 implementation proof and requires its own operator-approved
snapshot, service-stop/stage/start, rollback, and protected-surface equality
card.

## Closed credential gate and explicitly open gates

- **M4-CREDENTIAL/B:** exact-source build, target-host native Linux validation,
  positive cleanup, and protected equality are `passed`. No credential file or
  material remains in the live namespace or evidence package; filesystem-block
  secure erase is not claimed. This closure opens no adjacent gate.
- **M4-04 target authority:** the operator placed NET01 outside the program and
  corrected the live Revit workstation to PETRUCCI on 2026-08-13. Read-only
  locator and installed-surface evidence is retained in
  `docs/decisions/DP-12-PETRUCCI-readiness-2026-08-13.md`; the accepted live
  chain remains in `M3_BRIDGE_GATE_EVIDENCE.md`. The operator subsequently
  bound Gateway to `revagent` and the WP9 client, Bridge, add-in, and live Revit
  to PETRUCCI. DESKTOP-OKNV128 is not an M4 client. An active PETRUCCI Codex
  client session remains unproven, so this placement decision is not a live-
  gate approval.
- **M4-DNS/TLS-TRUST:** the production-origin and stopped-connector baselines
  remain [`DP-04`](../decisions/DP-04-domain.md) and
  [`DP-03/DP-04`](../decisions/DP-03-04-cloudflare-staging.md). M4 does not use
  `gateway.revagent.app` or start its connector. The separate test FQDN,
  DNS-only private-address record, trusted-CA DNS-01 certificate, narrowly
  scoped out-of-band token, and post-use token disposition remain operator-
  gated and unexecuted.
- **M4-CLIENT/LIVE:** external client, real tenant/OAuth flow, live Gateway
  exchange, and live Revit execution remain separately operator-gated.
- **M4-WRITE-CONFIRM:** preview/confirm/write execution against a live target
  remains separately operator-gated.
- **RES-30:** real Gateway token exchange, revoked-device refusal at handshake,
  and device-token persistence across reboot remain unproven. Reboot is not
  authorized by M4-02, M4-HOST, M4-03/A, or M4-CREDENTIAL/B.
- **Production exposure/deployment:** a production tunnel or public DNS route is
  outside M4-02, M4-03/A, and M4-CREDENTIAL/B. The self-hosted deploy runner
  remains deferred to M6; no runner, workflow, or CD change is authorized here.

## Park List

- The production-pruned Gateway image builds from exact sources
  `1882289733ff0f3849546443e24d6cedc2c9a2dd` and
  `9b7ead1396ac080ea90bf2923bd1ebe871847f3f` both reported `2 moderate / 1 high`
  in `npm audit`. This remains one non-blocking Park item for M4, requiring a
  separate planner-bound security disposition before the M5 security/auth lane
  begins. No automatic `npm audit fix` or dependency, manifest, or lockfile
  mutation was authorized or performed. Build-log evidence SHA-256 values:
  `269f3a10bfe8704773f5c1794774abea1ed79d436a4fb1e51ea3a3b2c03cd66d` and
  `0b113c3352dfe248637bbc2127032fbb692eb69d3414d5cf5123cd7834270841`.

## Submission rule

M4-02's bounded repo and authorized-host evidence is complete, the slice is
`passed`, and `PR #370` merged as `55a34032`. M4-03/A passed and `PR #372`
merged as `9b7ead13`; its merge-push CI is green. M4-CREDENTIAL/B also passed its
separately approved exact-source target-host execution and positive cleanup.
The M4 milestone ledger stays `in_progress` / `not_submitted` because
M4-CLIENT/LIVE, M4-WRITE-CONFIRM, RES-30, and the remaining planner-bound slices
are still open. No evidence result becomes milestone acceptance without the
milestone owner's explicit decision.
