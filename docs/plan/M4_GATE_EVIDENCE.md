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

**M4-04/A2 slice state:** `passed_merged`
([`PR #376`](https://github.com/BTankut/revAgent/pull/376) merged as
[`003fbc0d1a95be546c7b3ebdc36caa14e4f2b557`](https://github.com/BTankut/revAgent/commit/003fbc0d1a95be546c7b3ebdc36caa14e4f2b557))

**M4-04/A3 slice state:** `passed_merged`
([`PR #377`](https://github.com/BTankut/revAgent/pull/377) merged as
[`50e6cd9d0028bd480a378fd1201859fbdcbc13f3`](https://github.com/BTankut/revAgent/commit/50e6cd9d0028bd480a378fd1201859fbdcbc13f3))

**M4-04/A4 slice state:** `passed_merged`
([`PR #378`](https://github.com/BTankut/revAgent/pull/378) merged as
[`239de8d3826f25a12f858374f495d5ecfbd67e02`](https://github.com/BTankut/revAgent/commit/239de8d3826f25a12f858374f495d5ecfbd67e02))

**M4-04/A5 slice state:** `passed_merged`
([`PR #379`](https://github.com/BTankut/revAgent/pull/379) merged as
[`8dcb664ee721d706e69ed70a17620ded73bec292`](https://github.com/BTankut/revAgent/commit/8dcb664ee721d706e69ed70a17620ded73bec292))

**M4-04/A7 slice state:** `passed_merged`
([`PR #380`](https://github.com/BTankut/revAgent/pull/380) merged as
[`e9246cd1d51791db970bad800e6d2de418f5fc02`](https://github.com/BTankut/revAgent/commit/e9246cd1d51791db970bad800e6d2de418f5fc02))

**M4-04/B session state:** `blocked/partial`

**Plan binding:** `M4-02` is the planner-approved deterministic composition and
bounded-host decomposition of the M4 Gateway live path. `M4-03/A` is the
operator-approved repo seam limited to a versioned credential-file loader and
listenerless one-shot validator. `M4-CREDENTIAL/B` is the separately authorized
exact-source target-host proof of one native Linux credential load plus cleanup.
`M4-04/A` is the separately authorized repo-only pre-production serving seam;
it prepares no host, DNS, trust, credential, container, client, or Revit
operation. Gate 1 is the planner-authorized read-only PETRUCCI placement and
client-feasibility inspection. `M4-04/A2` is the separately authorized
repo-only credential generation and two-host secret-handoff seam. `M4-04/A3`
is the separately authorized repo-only value-free refusal observer; it exposes
the existing Gateway refusal and Bridge retry-pause decisions without changing
their semantics. `M4-04/A4` is the planner-bound repo-only CurrentUser-DPAPI
numeric-loopback bearer-broker seam. It does not install or run the broker on
PETRUCCI and does not open any M4-04/B execution gate. `M4-04/A5` is the
planner-bound repo-only listenerless protected enrollment-file consumer; it
adapts the A2 handoff artifact to the existing Bridge enrollment coordinator
without changing Bridge auth, retry, or observer semantics. `M4-04/A7` is the
planner-bound repo-only bounded, value-free projection and atomic protected
retained-artifact export of the pre-production Gateway's process-lifetime
invocation/confirmation audit. Success writes no stdout; it opens no route or
listener and never exports the raw event envelope. `M4-04/B` is the separately
authorized bounded live session that executed the two-host gate chain
`T0 -> G2 -> G3 -> G4A -> G4B -> G5 -> G7` against the pinned A7 image; this
tracker slice records its outcome and open items only and authorizes no further
host, network, credential, client, or Revit action. None of these
bounded slices by itself satisfies or enlarges the M4 milestone gate.

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

**M4-04/A4 exact slice base:**
[`50e6cd9d0028bd480a378fd1201859fbdcbc13f3`](https://github.com/BTankut/revAgent/commit/50e6cd9d0028bd480a378fd1201859fbdcbc13f3)

**M4-04/A5 exact slice base:**
[`239de8d3826f25a12f858374f495d5ecfbd67e02`](https://github.com/BTankut/revAgent/commit/239de8d3826f25a12f858374f495d5ecfbd67e02)

**M4-04/B exact session base:**
[`e9246cd1d51791db970bad800e6d2de418f5fc02`](https://github.com/BTankut/revAgent/commit/e9246cd1d51791db970bad800e6d2de418f5fc02)

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

The M4 test approach is the separate same-zone test FQDN
`m4-gateway.revagent.app`. In G2 the operator will create
`m4-gateway.revagent.app -> 192.168.90.154` as DNS-only (grey cloud), then
create the `_acme-challenge` TXT record with the exact value generated and
shown by the certificate order. DNS-01 supplies the publicly trusted
certificate; the publicly resolvable private target remains non-routable from
the public Internet. A6 is permanently canceled: no Cloudflare API token will
be generated or requested. G7 must delete both A and TXT records and retain the
operator's positive confirmation. No DNS record or certificate exists merely
by virtue of the repo seam.

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
| Binary receiver feasibility | No `node.exe` existed on `PATH`, under canonical `C:\Program Files\nodejs`, or in the revAgent installed receipt. Codex's user-writable bundled Node `v24.14.0` at `C:\Users\ws2\AppData\Local\OpenAI\Codex\runtimes\cua_node\23828fd353da361d\bin\node.exe` had SHA-256 `1acf46c7fc017391d28871ec7b8db3f037beafe778d39c5131ba6013704bbb8d`, a valid OpenAI signature, and preserved a 38-byte NUL/`0xff` binary stdin probe exactly (input/output SHA-256 `0e8c271bb2e79c6723d2621f2e25527911e2795f73c6d8db959ab2673a16b469`, empty stderr). Its AppData origin and mutable Codex lifecycle do not satisfy revAgent's protected Program Files/OpenJS runtime authority. | raw-stdin mechanics passed; Codex Node rejected as execution authority; A2 uses a self-contained receiver |
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

**Gate state:** `passed_merged`

**Scope of record:** protected source is
`6aa04593657fa2e3ee8a656ff97b553daf07f29e`. This repo-only slice owns one
OS-CSPRNG generator for the three M4 pre-production credential fields, a
bounded binary two-host handoff for the allowlisted `north_bearer` and
`enrollment_artifact` classes, a self-contained .NET 8 `win-x64` destination
receiver, and
deterministic tests for success, refusal, timeout/failure cleanup, and
value-free output. Secret fixtures use a recognizable `SYNTHETIC-...` prefix.
The receiver replacement is deliberate: a live deterministic fixture proved
that Windows PowerShell 5.1 `-File` binds redirected stdin to its script
pipeline and can echo raw frame bytes into parameter-binding diagnostics.
PowerShell is therefore only the coordinator; it never parses or hosts secret
stdin. The receiver is single-file/self-contained, validates its own pinned
SHA-256 before reading stdin, and requires no PETRUCCI Node or .NET install.
The slice uses only existing platform libraries; root lockfile churn remains a
stop condition.

The generator must produce three independent 48-byte values; create only an
exclusive, canonical, owner-bound POSIX `0400` file below exact `0700`
ancestors; sync and close its handle; validate it through the existing
listenerless M4-03 loader; and positively prove absence after any owned failure.
The handoff must keep secret bytes off argv, environment, transcript, log, and
evidence surfaces; enforce closed secret classes and byte bounds; use binary
streams rather than PowerShell text pipelines; share one bounded deadline; and
positively verify owned source/destination cleanup on every failure.
The coordinator uses a two-phase commit: it relays the bounded frame, waits for
the source process to terminate, then uses one attempt-scoped container name to
stop/remove any surviving remote Docker process and positively proves both
that container and the exact source file absent. Only then does it send the
receiver's commit byte, and only when the bounded source stderr is also exactly
empty. A failed/uncertain source metadata or cleanup/probe sends an abort byte,
and both endpoint probes decide the final result. Local `ssh.exe` termination
alone is never accepted as remote-container termination. No source or
destination error text is forwarded into evidence.

The path/identity cleanup guards operate inside exact owner-isolated roots
(`0700` on Linux; current user, SYSTEM, and Administrators only on Windows).
They defend against cross-principal replacement and make detected uncertainty
fail closed; they do not claim atomic deletion against a malicious concurrent
actor already running as the same OS principal. Such an actor can already read
or replace that principal's credential material and is outside this seam's
threat boundary. Cleanup is therefore described as identity-checked plus
positive absence, not as an absolute handle-bound unlink guarantee.

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
variance. **Actual:** `1.50h` active effort. **Variance:** `-0.25h` (`-14%`).
Passive CI/review waits are excluded.

**Local implementation evidence:**

- Generator/source focused Vitest: `2` files, `99` tests passed. The generator
  uses three independent 48-byte OS-CSPRNG calls, exclusive no-follow `0400`
  creation, hardened loader validation, post-close path/identity checks, and
  identity-checked failure cleanup. Source error reasons pass a closed runtime
  allowlist; transferred buffers are cleared after their awaited binary write.
- Gateway lint, typecheck, and production build passed under the pinned Node 24
  toolchain.
- The complete local CI-safe engineering gate passed in `666s`, including
  `308` Contracts tests, `796` Bridge tests, both new handoff harnesses, source-
  free/distribution guards, runtime MCP suites, and repository classifiers.
- The self-contained receiver publish and Windows ACL/frame/refusal/cleanup
  harness passed. The coordinator's independent-process matrix passed success,
  deliberate north refusal, source failure/abort, invalid destination frame,
  exit-zero source stderr/abort, timeout, source container/file cleanup
  uncertainty, and destination cleanup uncertainty. The production wrapper
  assigns an attempt-scoped container,
  forcibly removes a survivor, and requires a clean Docker inventory plus
  exact source-file absence before commit.
- Root `package-lock.json`, npm `package.json` manifests, workflows, runner,
  CD/signing, and NAS surfaces have no diff. The new self-contained receiver's
  `.csproj` is an intentional in-scope project manifest. No real secret, SSH
  handoff, host mutation, container, Codex configuration, Bridge, Revit,
  DNS/TLS, or later gate was exercised.
- The protected implementation passed [`PR #376`](https://github.com/BTankut/revAgent/pull/376)
  Engineering gates, Gateway gates, Gateway CI, and Claude review. It squash-
  merged as [`003fbc0d`](https://github.com/BTankut/revAgent/commit/003fbc0d1a95be546c7b3ebdc36caa14e4f2b557).
  The merge-push run was green on attempt 1: [Engineering and Gateway gates,
  run 31740826366](https://github.com/BTankut/revAgent/actions/runs/31740826366)
  plus [Gateway CI, run 31740826363](https://github.com/BTankut/revAgent/actions/runs/31740826363).
  Signed Source-Free CD also ran because its current path filter includes
  `scripts/**`, which A2 changed; [run 31740826399](https://github.com/BTankut/revAgent/actions/runs/31740826399)
  passed on attempt 1 with artifact upload and NAS publish both skipped.

**Red-attempt dispositions:**

- The first PowerShell receiver fixture timed out, then exposed raw synthetic
  frame fragments in `-File` parameter-binding stderr. Root cause was the
  PowerShell text-pipeline boundary, not product timing. That receiver was
  removed and replaced by the raw-stdin self-contained executable; both the
  confidentiality canary and bounded coordinator matrix are now green.
- Early full-Gateway attempts failed before tests because `better-sqlite3` was
  absent after `npm ci --ignore-scripts`, then had Node ABI `127` while the
  pinned runner was ABI `137`; one intermediate dependency-junction race also
  prevented resolution. Rebuilding the native dependency under the exact Node
  24 runtime removed those environment-only failures; the full suite passed.
- One focused command named a nonexistent Gateway Vitest config; rerunning with
  the repository's root configuration passed. Later typecheck and focused-test
  reds were test-harness types introduced while adding zeroization
  (`Uint8Array.readUInt32BE` / Buffer preservation); the harness was corrected,
  and lint, typecheck, build, and all `99` focused tests pass.
- A first combined-CI launch was terminated by the coordinator's one-second
  command timeout before a repository test result existed; no attempt-owned
  process remained. It was rerun with the intended bounded wait. A separate
  Windows PowerShell 5.1 review run initially reported `argv count drifted`
  because its `ConvertFrom-Json` array enumeration differs from PowerShell 7;
  explicit array normalization fixed the cross-shell harness, and the direct
  PowerShell 5.1 receiver/coordinator run passes.

## M4-04/A3 observer disposition

**Gate state:** `passed_merged`

**Planner decision:** `A3 bound` on 2026-08-13.

**Scope of record:** protected source is
`003fbc0d1a95be546c7b3ebdc36caa14e4f2b557` (`PR #376` squash merge).
This repo-only slice exposes the already-existing revoked-opening chain through
one versioned value-free observer contract:
`revagent.m4-rbp-refusal-observer/v1`. The existing RBP `hello.id` is the only
cross-host correlation identity. Gateway records the correlated opening
refusal using closed codes; Bridge records the resulting final
`RetryPaused/Auth/Pause` snapshot immediately before the existing retry-
authority wait. Neither event may include a credential, token, header, device
identity, endpoint, hostname, path, exception, stack, or arbitrary failure
message.

The observer is downstream of existing decisions. It must not change 4403
mapping, failure classification, reducer semantics, retry/fallback selection,
timers, semaphore/signals, connection count, enrollment, journal, worker exit,
or protocol frames. Observer callback/log failures are best-effort and must be
swallowed without notifying retry authority or altering lifecycle state.
Deterministic tests must prove exact closed fields, same-`hello.id`
correlation, exactly-once emission, value-free output with recognizable
`SYNTHETIC-...` canaries, callback-failure isolation, and continued pause until
the pre-existing retry signal is explicitly changed.

**Explicitly out:** PETRUCCI or `revagent` access, binary build/stage/install,
Bridge service/config mutation, backup/restart/restore, live Gateway or
container execution, real credential/device/tenant/OAuth exchange, DNS/TLS/UFW
or tunnel work, Codex configuration, Revit/model operations, reboot,
write/confirm, workflow/runner/CD/signing/NAS changes, doctor or
`AuthDiagnosticPath`, protocol schema, dependency/manifest/lockfile changes,
and any A4 client-auth implementation. A later Bridge-stage card must bind an
exact binary digest, config backup, bounded service stop/start, rollback, and
protected-surface equality before PETRUCCI execution.

**Forecast:** `2.25h` active effort, calibrated against the prior M2 `-72%`
and A2 `-14%` variances. **Actual:** `1.00h` active effort. **Variance:**
`-1.25h` (`-56%`). Passive CI/review waits are excluded.

**Local implementation evidence:**

- Gateway emits the exact frozen
  `revagent.m4-rbp-refusal-observer/v1` record only for an RBP opening
  authorization `403/4403`. HTTP and WSS reuse the existing `hello.id`; WSS
  claims its attempt-local observer guard before invoking either sink, so
  concurrent duplicate hello frames still emit exactly once.
- Default Gateway evidence is one value-free JSONL record submitted through a
  callback-based non-blocking stderr write. Immediate, callback-time, sync, and
  async observer failures are swallowed; deterministic tests hold both async
  sinks unresolved until after the authoritative WSS `4403` close. The focused
  ingress suite passed `11/11`, including `10/10` repeated concurrent-race
  runs. The complete Gateway package passed `37/37` files and `431/431` tests;
  one Windows-only POSIX permission smoke remained the pre-existing expected
  skip. The packaged-handler manifest stayed
  `sha256:cb193dc22716e12217edc4f5516c7145eb6e42a488c6360777b01e977644ecde`.
- Bridge carries value-free opening context only through the WSS hello exchange
  or the HTTP create/hello request. A successful HTTP `hello_ack` followed by
  an event-stream `403` has no opening context and cannot masquerade as the
  correlated revoked-opening chain. After the existing reducer enters
  `RetryPaused/Auth/Pause`, a `Func<..., ValueTask>` observer exposes the closed
  snapshot immediately before the existing retry-authority wait; synchronous
  and post-await callback faults are observed and swallowed.
- The Release Bridge solution built with `0` warnings and `0` errors. Contracts
  passed `308/308`; Bridge passed `800/800`. Regression tests prove exact closed
  fields, recognizable `SYNTHETIC-...` canary absence, WSS and HTTP correlation,
  post-ack event-stream exclusion, callback-failure isolation, one failed
  attempt, and continued pause until the pre-existing retry-condition signal.
- Root `package-lock.json` remains byte-identical at blob
  `b3d8df2755b2ead322f36100bc1c0fb177af082c`. Package manifests, workflows,
  runner, CD/signing, and NAS surfaces have no diff. No host, stage, service,
  credential, container, DNS/TLS, client, Revit, or other live operation was
  performed.

**Protected closure evidence:** final head
`7701b1bfc914fa004f5f9008670b0163c80e16ec` passed
[CI 31745814390, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31745814390/attempts/1),
[Gateway CI 31745814348, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31745814348/attempts/1),
and [Claude review 31769245073, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31769245073/attempts/1).
`PR #377` squash-merged as `50e6cd9d0028bd480a378fd1201859fbdcbc13f3`.
Its merge-push [CI 31769428226, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31769428226/attempts/1)
passed Engineering and Gateway/RBP gates, and
[Gateway CI 31769428229, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31769428229/attempts/1)
passed. Signed Source-Free CD did not trigger; the unrelated M0 Gateway CD stub
was skipped. No rerun was used.

**Red-attempt and review dispositions:**

- The first fresh-worktree Gateway package attempt used Node 22 after an
  `--ignore-scripts` install; two unchanged SQLite tests could not load
  `better-sqlite3`. The A3 ingress test itself was green. Rebuilding the native
  dependency under Node 24 removed this environment-only ABI/preparation
  failure; the full `431`-test package then passed.
- Early focused Bridge preparation lacked the ignored generated simulator
  package, then a test-project-only full run lacked the PowerCut harness and
  reported five harness-launch failures while the other `794` tests passed.
  Exact npm preparation plus a solution restore/build produced the final
  `800/800` Bridge and `308/308` Contracts result. No product assertion failed
  after the required build outputs existed.
- Independent review found three observer-boundary defects before commit: a
  synchronous default Gateway stderr write could delay refusal; an HTTP
  post-`hello_ack` event-stream `403` inherited opening correlation; and an
  `Action<T>` Bridge seam could admit an escaping `async void` fault. They were
  respectively replaced by callback-based non-blocking logging, create-only
  HTTP context, and an observed `Func<T, ValueTask>` seam, with the regression
  proofs above. No auth classification, reducer, retry authority, timer,
  connection, protocol-frame, or Bridge auth/retry behavior was changed.

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

A3's minimum repo scope is therefore a value-free Gateway refusal correlation
plus a value-free Bridge `RetryPaused/Auth` observer. Any Bridge binary stage
remains outside A3 implementation proof and requires its own operator-approved
snapshot, service-stop/stage/start, rollback, and protected-surface equality
card.

## M4-04/A4 CurrentUser bearer-broker seam

**Gate state:** `passed_merged`

**Planner decision:** `A4 bound` on 2026-08-14. Route 1 is a
CurrentUser-DPAPI numeric-loopback bearer broker; the listenerless stdio route
recorded by E4 is the fail-closed fallback, not an implicit second path.

**Scope of record:** protected source is
`50e6cd9d0028bd480a378fd1201859fbdcbc13f3` (`PR #377` squash merge). This
repo-only slice owns an explicit `north_bearer` destination disposition, a
self-contained Windows broker that retains only CurrentUser-DPAPI ciphertext,
an exact numeric-loopback Streamable HTTP endpoint, and a secretless Codex
registration containing only that local URL. The legacy A2 north refusal stays
the default and remains valid history; only the explicit A4 disposition may
retain the protected destination.

The broker must authenticate the local caller before decrypting or injecting
the bearer. The bound evidence chain is the exact established IPv4 tuple to one
PID, an open process handle held through the request, `PETRUCCI\ws2` SID and
account, exact protected Codex image path and SHA-256, exact package family and
valid expected signer, followed by repeated tuple and process-identity checks.
The TCP direction must resolve the accepted connection's remote endpoint as the
client; resolving and attesting the broker's own listener PID is a refusal.
Incoming authorization, cookie, proxy, forwarding, and hop-by-hop headers are
discarded; the broker alone injects the bearer to the exact HTTPS test origin.

Acceptance requires deterministic CurrentUser-DPAPI round-trip and cleanup,
strict root/file ACL and identity checks, no plaintext file, exact
numeric-loopback binding, bounded Streamable HTTP forwarding including SSE and
cancellation, zero upstream calls for an unauthorized caller, secretless Codex
TOML, unchanged stdio-default behavior, and explicit tests proving recognizable
`SYNTHETIC-...` values and distinguishing fragments never enter argv, env,
TOML, stdout/stderr, exceptions, logs, or evidence. The root npm lockfile must
remain byte-identical.

**Stop / fallback rule:** if the live PETRUCCI connection cannot be reliably
bound to `PETRUCCI\ws2` and one exact Codex image/signer/package profile, Route
1 stops. The allowlist must not broaden to a helper family, user-writable copy,
or ambiguous owner. Route 3 then requires its own planner-bound implementation
slice and operator-approved stage. This user-mode attribution is not claimed
to isolate a fully compromised process already running as the same Windows
user, administrator, or SYSTEM.

**Explicitly out:** PETRUCCI or `revagent` access, broker build/stage/install or
execution outside repository tests, real credential generation or use, Codex
configuration mutation, Gateway/container or Bridge stage, DNS/TLS/UFW/tunnel
work, enrollment/revoke, tenant/OAuth, external/live client, Revit/model
operation, reboot/persistence, write/confirm, production origin/deploy,
workflow/runner/CD/signing/NAS changes, and implementation of the stdio
fallback. Each remains behind its existing separate gate.

**Forecast:** `5.50h` active effort. **Actual:** `1.75h` active effort.
**Variance:** `-3.75h` (`-68%`). Passive CI/review and later live-gate waits
are excluded.

**Local implementation evidence:**

- The self-contained `net8.0-windows` broker accepts the A2 handoff frame only
  through standard input, retains only `CurrentUser` DPAPI ciphertext beneath a
  protected, non-reparse, single-link root/file chain, and exposes fixed,
  value-free receive, absence-probe, cleanup, and refusal metadata. Deterministic
  negatives cover inherited or broad ACLs, hardlinks, reparse paths when the
  host permits their creation, and a foreign/non-narrow replacement that cleanup
  must not delete.
- Every proxied request is authorized before decrypting the bearer. The caller
  authority resolves the accepted IPv4 connection's reverse tuple to one
  non-broker PID, opens and retains that process plus its protected image, and
  checks exact SID/account, AppX package/full-name/path, image SHA-256, valid
  OpenAI signer subject, and operator-pinned signer thumbprint before and after
  forwarding. Unauthorized callers make zero upstream calls and trigger zero
  decrypts. The mutable bearer buffer is zeroed after success, refusal,
  cancellation, and upstream failure; no stronger claim is made about immutable
  framework strings or a process already compromised under the same user,
  Administrator, or SYSTEM authority.
- The broker binds only canonical `http://127.0.0.1:1024..65535/mcp`, forwards
  only `GET`/`POST`/`DELETE` to
  `https://m4-gateway.revagent.app/mcp`, strips caller auth/cookie/proxy/
  forwarding and unlisted headers, and preserves bounded MCP/SSE response
  streaming and cancellation. Its `13` focused scenarios pass under both
  PowerShell 7 and Windows PowerShell 5.1; the final root rerun was `4.70s` with
  `0` build warnings and `0` build errors.
- The A2 coordinator keeps `north_refusal_v1` as its exact default and exposes
  `current_user_dpapi_broker_v1` only for `north_bearer`. The explicit route
  reserves ordered absolute deadlines at `40/50/65/70/80/85/100%` for operation,
  source stop, source absence proof, destination stop, destination cleanup,
  cleanup stop, and positive destination absence proof. Native process-handle
  waits and ownership guards prevent inherited stdout/stderr or an incomplete
  pipe copy from bypassing those deadlines. Fifteen-second source and
  destination pipe-holder regressions remain below their `9.50s` ceiling, and a
  real operation timeout proves the source cleanup probe ran before destination
  disposition. The final focused coordinator suite passed under PowerShell 7
  in `47.82s` and Windows PowerShell 5.1 in `48.59s`.
- Codex registration preserves stdio as the default. The explicit A4 mode
  atomically replaces only the managed runtime table with the exact secretless
  numeric-loopback URL, retains the docs server on stdio, verifies the current
  `streamable_http` CLI readback shape with every bearer/header field absent,
  and is wired through the hardened public installer entrypoint. Ports below
  `1024`, aliases, wildcard/IPv6 hosts, and path/query/fragment drift fail before
  mutation. The final Codex integration-security suite passed in `46.35s`.
- The recognizable `64`-character synthetic bearer and distinct head/middle/
  tail fragments are absent from DPAPI ciphertext and every exercised public
  output/error/evidence surface. Registration tests separately prove their
  absence from TOML, result/readback/error data, and observed child argv/env.
  Root `package-lock.json` remains byte-identical at blob
  `b3d8df2755b2ead322f36100bc1c0fb177af082c`; the new project has no
  `PackageReference`. No host, credential, Codex user configuration, DNS/TLS,
  Gateway, Bridge, Revit, workflow/runner, signing, CD, or NAS operation ran.
  The implementation necessarily changes `installer/**`, so the later approved
  merge is expected to trigger Signed Source-Free CD and its terminal result
  must be reported.
- The final common local tree passed `scripts/test-all.ps1` with exit `0` in
  `777.50s` and `scripts/test-ci.ps1` with exit `0` in `780.97s`. The latter
  includes the same `13` broker scenarios, coordinator and Codex security
  regressions, Bridge suites, release guards, and CI-safe engineering gates.

**Protected closure evidence:** final PR head
`17e8375d5683cdccb2f3c21cd2ed0c6140a0a197` passed
[CI 31781722442, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31781722442/attempts/1),
[Gateway CI 31781722487, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31781722487/attempts/1), and
[Claude review 31789332568, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31789332568/attempts/1).
`PR #378` squash-merged as
`239de8d3826f25a12f858374f495d5ecfbd67e02`. Its merge-push
[CI 31789828249, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31789828249/attempts/1)
passed Engineering and Gateway/RBP gates. Installer-path changes triggered
[Signed Source-Free CD 31789828190, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31789828190/attempts/1),
whose build/validation passed and NAS publish job was skipped as expected. No
rerun was used.

**Red-attempt and review dispositions:**

- Initial broker preparation failed on missing restore assets, three incorrect
  framework API assumptions, a self-contained test/project mismatch, and the
  test source being compiled as a second entrypoint. Restore, the pinned .NET 8
  APIs, matching test RID, and explicit test-source exclusion closed these
  build-only failures; the final build has no warning or error.
- Early broker harness runs exposed Windows PowerShell 5.1 differences in ACL
  extension discovery, `ProcessStartInfo.ArgumentList`, UTF-8 BOM handling,
  `Span<byte>` binding, string overloads, and process-tree kill overloads. The
  runner now uses bounded compatibility paths already supported by the repo;
  both PowerShell editions pass the same `13` scenarios. A RID-dependent source-
  root calculation also made the no-argv test scan its own `--bearer` fixture;
  resolving from the repo working directory removed that harness-only false
  positive. A separately attempted external symlink feasibility command was
  blocked before execution by shell policy, so the final proof uses deterministic
  identity policy plus native .NET symlink fixtures where the host permits them.
- Independent review found that an early proxy loaded plaintext before caller
  authorization and that its first caller policy was broader than the bound
  exact image/package/signer identity. Decrypt was moved behind a retained
  authorization lease, identity was pinned exactly, and deterministic native-
  negative, tuple/process-sandwich, ACL, reparse, hardlink, replacement,
  zero-decrypt, zeroization, and fragment-leak regressions were added.
- Coordinator harness iterations exposed `OrderedDictionary` property lookup,
  PowerShell 5.1 BOM and nullable binding, an unconsumed stop-helper boolean,
  an undersized receiver-abort window, and a residue-negative expectation that
  contradicted positive-absence semantics. These were respectively corrected
  with dictionary-key lookup, the production receiver's exact optional-BOM
  rule, direct integer binding, voided helper output, a distinct destination
  stop window, and the required `exit 79` plus retained-residue expectation.
  Review then found three boundedness defects:
  synchronous stream harvest after uncertain stop, no source-proof budget after
  an operation timeout, and a second synchronous commit/abort write while an
  incomplete copy still owned the destination pipe. Fixed metadata harvesting,
  distinct ordered deadlines, native handle waits, and the incomplete-copy
  ownership guard close all three; the adversarial `45s` suite is green.
- Registration tests initially had fixture-only scalar/name mismatches. The
  corrected fixtures now prove both the legacy stdio result shape and the exact
  secretless HTTP shape. Review also found a `1..1023` registration range that
  the broker would refuse; both layers now share the canonical
  `1024..65535` contract. The protected implementation-head failure and its
  complete disposition are recorded below.
- The first local `test-ci` launcher used a `5s` orchestration timeout. The
  tool returned `124` before any test result, left one child briefly running,
  and lost that child's exit/output; it is therefore not counted as a test
  attempt. The child was confirmed absent before the single evidence-bearing
  rerun above, which completed normally with exit `0`.
- Implementation head `32237beadf7da3a61913725645b7e9dae7239f29` produced
  one deterministic protected red in
  [CI 31775848515, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31775848515/attempts/1):
  [Engineering job 94691012437](https://github.com/BTankut/revAgent/actions/runs/31775848515/job/94691012437)
  failed before the coordinator cases because PowerShell 7 does not support
  `Add-Type -OutputType ConsoleApplication`. The failing test file was in this
  slice's diff, so no same-head rerun was used. The fixture now compiles from a
  temporary SDK project under both PowerShell editions. That portability fix
  then exposed a real deadline-wiring defect: after a timed-out source absence
  probe, the receiver wait reused the `65%` `SourceProof` deadline instead of
  the distinct `70%` `DestinationStop` deadline, leaving no receiver abort
  grace. The coordinator now uses the bound destination deadline; the
  adversarial lifecycle case and both full local gates pass. The same protected
  run's [Gateway job 94691012520](https://github.com/BTankut/revAgent/actions/runs/31775848515/job/94691012520)
  passed, as did
  [Gateway CI 31775848467, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31775848467/attempts/1).

## M4-04/A5 protected enrollment-file consumer

**Gate state:** `passed_merged`

**Planner decision:** `A5 bound` on 2026-08-14 as a hard prerequisite for the
single bounded M4-04/B live session.

**Scope of record:** protected source is
`239de8d3826f25a12f858374f495d5ecfbd67e02` (`PR #378` squash merge). This
repo-only slice owns one listenerless Bridge command that consumes the A2
receiver's protected `enrollment.json`, validates it without placing the token
in argv or environment, invokes the existing `BridgeEnrollmentCoordinator`
re-enrollment behavior in memory, and positively removes the source file on
every owned terminal path: success, semantic refusal, invalid or expired
artifact, coordinator or exchange failure, timeout, and cancellation. Cleanup
must prove positive absence, and must never delete a foreign replacement whose
identity and ownership were not proven.

Acceptance requires the exact `revagent.m4-enrollment-artifact/v1` contract;
strict bounded UTF-8/JSON shape, token and expiry validation; a fully qualified
canonical local path; no device namespace, UNC, mapped drive, alternate data
stream, reparse component, or hard link; protected owner/DACL compatibility
with the A2 Windows receiver; stable file identity across validation/read/
cleanup; a single bounded attempt; and a fail-closed result when positive
absence cannot be proved. Recognizable `SYNTHETIC-...` fixtures and distinct
head/middle/tail fragments must be absent from argv, environment, stdout,
stderr, exceptions, logs, and retained evidence on both success and every
error path. The implementation must not redefine Bridge auth, retry,
`RetryPaused/Auth`, observer, exchange, or credential-store semantics, and the
root npm lockfile must remain byte-identical.

**Explicitly out:** PETRUCCI or `revagent` access, Bridge stage/service/config
mutation, real enrollment or credential use, Gateway/container/image build,
DNS/TLS/ACL, Codex broker/client execution, Revit/model access, revoked-device
exercise, reboot/persistence, write/confirm, production deploy/tunnel,
workflow/runner/CD/signing/NAS changes, and the separately bound A7 audit
export. Each remains behind its existing gate.

The path allowlist for this slice is `packages/bridge/**`, Bridge tests, and
these M4 tracker/evidence records only. `packages/protocol/**`,
`packages/gateway/**`, `src/revit-plugin/**`, and `installer/**` are explicitly
outside the slice.

**Forecast:** `2.00h` active effort, calibrated against the prior M2 `-72%`
variance. **Actual:** `1.75h` active effort. **Variance:** `-0.25h` (`-13%`).
Passive CI/review and operator waits are excluded.

**Local implementation evidence:**

- The exact internal `__re-enroll-file` command accepts only absolute
  configuration and canonical `enrollment.json` paths. It starts no worker,
  listener, host, or doctor flow. The whole command is bounded to `45s`, sends
  cancellation with `5s` cleanup lead, and returns value-free closed JSON with
  exit `79` when cleanup absence is uncertain.
- The consumer accepts only the exact
  `revagent.m4-enrollment-artifact/v1` three-field object, canonical positive
  decimal expiry, visible-ASCII token bytes, and the bounded `32..4096` byte
  token / `4096` byte file limits. Mutable file and token buffers are zeroed.
  Expired, overlong, duplicate, unknown, escaped-name, BOM, trailing-data, and
  non-canonical inputs are refused before enrollment.
- The Windows source pins one no-follow handle through bounded read and
  handle-bound deletion. It verifies canonical local path, exact leaf, current
  user owner, protected current-user/SYSTEM/Administrators DACL, regular file,
  stable identity, single hardlink, no reparse ancestor, and no alternate data
  stream at open, read, and disposition. A foreign replacement is retained and
  reported as `cleanup_uncertain`; owned paths require positive post-unlink
  absence before exchange begins.
- Re-enrollment requires the already-existing machine identity and fingerprint.
  A missing identity, fingerprint, or protected store fails without creating a
  credential directory, lock, identity, fingerprint, or exchange. Existing
  enroll/re-enroll paths retain their prior create/recovery semantics, and A5
  does not change Bridge auth, retry, `RetryPaused/Auth`, observer, or exchange
  behavior.
- Recognizable `SYNTHETIC-...` canaries and distinct fragments are absent from
  argv, environment, result JSON, errors, exceptions, and exercised evidence.
  Ambient legacy-token ambiguity is refused without reading the artifact, but
  still performs the same positive source cleanup before returning.
- The final focused A5 suite passed `57/57`; formatting verification passed.
  The final common tree passed `scripts/test-all.ps1` with exit `0` in
  `745.8s` (Contracts `308/308`, Bridge `850/850`) and
  `scripts/test-ci.ps1` with exit `0` in `752.1s`, ending with `All CI-safe
  revAgent engineering gates passed.`
- Root `package-lock.json` remains byte-identical to protected source at blob
  `b3d8df2755b2ead322f36100bc1c0fb177af082c`. The diff stays within
  `packages/bridge/**`, Bridge tests, and these M4 records. No host, credential,
  enrollment, image, DNS/TLS/ACL, broker/client, Revit, workflow/runner,
  signing, CD, or NAS operation ran.

**Protected implementation evidence:** the scope-record head
`945e9093566c99b24754b2a068f3ef47e49d0c1d` passed
[CI 31799865959, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31799865959/attempts/1)
and
[Gateway CI 31799865960, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31799865960/attempts/1).
Implementation head `78bfd189113a7a3bc1d154e8b1100fcab7f7d1e8` passed
[CI 31805770391, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31805770391/attempts/1),
including both Engineering and Gateway gates, and
[Gateway CI 31805770374, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31805770374/attempts/1).
Final PR head `7be7ab3056e055b7b975881a5b6db63e1ed7fdf0` passed
[CI 31807074847, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31807074847/attempts/1)
and
[Gateway CI 31807074919, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31807074919/attempts/1).
[Claude review 31814037252, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31814037252/attempts/1)
then passed without a new commit. `PR #379` squash-merged as
`8dcb664ee721d706e69ed70a17620ded73bec292`; its merge-push
[CI 31814356194, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31814356194/attempts/1)
passed both Engineering and Gateway/RBP jobs. No rerun was used. No
`installer/**` path changed, and no Signed Source-Free CD run was triggered.

**Red-attempt and review dispositions:**

- The first full Bridge Debug run had `32` fixture-build failures because the
  clean worktree did not yet contain the root Node development dependency used
  by those fixtures. Canonical `npm ci --ignore-scripts` plus the locked .NET
  restore supplied the declared dependencies without changing the lockfile;
  the same sources then passed, and both final Release-based local gates above
  are green.
- Independent review identified three slice blockers: ambient-token refusal did
  not initially clean the artifact, the command lacked a whole-operation hard
  bound, and alternate streams were checked only at open. The final consumer
  performs no-read cleanup on ambiguity, the executable enforces the `45s/5s`
  bound, and ADS inventory is revalidated before/after read and immediately
  before disposition. Dedicated regressions for all three pass.
- One earlier local `test-ci` execution produced too much orchestrator output
  for its terminal record to survive context compaction. It showed no test
  failure signature and is not counted as evidence. After confirming no test
  runner remained, the same unchanged source tree was run once more to the
  recorded exit `0` terminal above. No GitHub rerun was used.

## M4-04/A7 bounded value-free audit export

**Gate state:** `passed_merged` — `PR #380` merged as
`e9246cd1d51791db970bad800e6d2de418f5fc02`, which became the pinned protected
source for the M4-04/B bounded live session.

**Planner decision:** `A7 bound` on 2026-08-14 as a `2.00h` hard prerequisite
for the single bounded M4-04/B live session.

**Scope of record:** protected source is
`8dcb664ee721d706e69ed70a17620ded73bec292` (`PR #379` squash merge). This
repo-only slice owns one listenerless, single-attempt export of the existing
pre-production event sink's process-lifetime `tool.invocation` and
`tool.confirmation` records. The exporter must project a new closed
`revagent.m4-value-free-audit-export/v1` contract; it must never serialize or
spread the raw `revagent.event.v2` envelope. The completed bundle is retained
only as the deterministic sibling `<enrollment-output-stem>.audit.jsonl`,
derived from the already-bound absolute `enrollmentOutputPath`; A7 adds no CLI
path or flag.

The configured live principal and Gateway session are selectors used only for
exact in-process comparison. The export represents successful selector matches
as booleans and must not emit tenant, user, device, principal, OAuth, Gateway,
MCP, RBP-session, host, endpoint, path, document/model, parameter/result,
preview-reference, confirmation-reason, header, raw error, exception, stack, or
unknown payload values. It may emit only validated correlation identifiers,
canonical digests, registry-bound tool metadata, closed policy/executor/outcome
enums, timing fields, and boolean binding evidence. `eventId` remains distinct
from recovery `auditId` / protocol `audit_id`; A7 must not synthesize either.

Acceptance requires exact profile `lan_test`, mode `preproduction`, and a
code-derived `approvedLiveSelector=true`; at least one selected record; no more
than `128` input events and `64` selected records; no more than `4096` serialized
bytes per record or `131072` bytes total; deterministic `seq`, then `eventId`
ordering; duplicate sequence/identifier refusal; a `5s` whole-export deadline;
and no partial or truncated retained artifact on any schema, selector, limit,
deadline, staging, verification, or publish failure. Success stdout must remain
empty; only fixed value-free refusals may reach stderr. An ordinary refusal
before atomic publish is complete only after both the final path and owned
temporary residue are positively absent; inability to prove cleanup is a
distinct fatal `artifact_cleanup_failed` stop and never a clean-refusal claim.
The live serving process may expose only a one-shot shutdown/writer seam on its
existing `SIGINT`/`SIGTERM` path; A7 must not add an HTTP, MCP, RBP, admin,
signal-specific, or other listener. Recognizable `SYNTHETIC-...` secret and
personal-data canaries plus distinguishing head/middle/tail fragments must be
absent from success, refusal, stdout, stderr, exception, and retained-evidence
surfaces.

**Explicitly out:** host, image build, container, Bridge/add-in stage or
behavior, credential/enrollment/revoke execution, DNS/TLS/ACL, broker/client,
Revit/model, reboot/persistence, write/confirm execution, production mode or
tunnel/deploy, workflow/runner/CD/signing/NAS changes, and any change to A3
observer, Bridge auth/retry, or Gateway authorization semantics. Each remains
behind its existing separate gate.

The path allowlist is `packages/gateway/src/preProductionAuditExport*`,
`packages/gateway/src/preProductionAuditWriter*`,
`packages/gateway/src/preProductionAuditFile*`, and the minimum existing
`packages/gateway/src/preProductionServing*` integration/tests, Gateway package
documentation if required, and these M4 tracker/evidence records only.
`packages/protocol/**`, `packages/bridge/**`, `src/revit-plugin/**`,
`installer/**`, root manifests/lockfiles, workflows, runner, CD/signing, and NAS
surfaces are outside this slice. Root `package-lock.json` must remain blob-
identical.

**Implementation:** the projector validates the exact pre-production event
source, live principal/session selector, registry tool binding, closed
policy/executor/outcome vocabulary, UUID/digest/timestamp fields, deterministic
order, duplicate refusal, and every count/byte bound before returning a frozen
bundle. A non-forgeable in-process provenance guard prevents a cast, extra-field
object, or `toJSON` hook from bypassing that projection at the writer.

The writer owns one attempt and derives `<enrollment-output-stem>.audit.jsonl`
beside the existing `enrollmentOutputPath`. It stages bytes in an
`O_EXCL`/`O_NOFOLLOW` temporary file at mode `0400`, writes and fsyncs them,
verifies owner/mode/size, rechecks abort state, and performs a synchronous
same-filesystem hard-link/no-clobber publish. It then removes the temporary
link, revalidates artifact identity, and fsyncs the directory before marking
the attempt committed. Normal failure before that commit removes owned residue
and leaves no final artifact; an unverifiable removal becomes the separate
value-free fatal `artifact_cleanup_failed` stop. A monotonic commit-point check
prevents a synchronous filesystem stall from bypassing the `5s` deadline, and
a deadline cannot reclassify success after commit. Success stdout is empty and
only fixed value-free refusals use stderr.

The existing serving lifecycle performs
`cleanup -> event flush -> detached snapshot -> projection -> atomic retained-artifact publish`
on `SIGINT`/`SIGTERM`. `SIGUSR2` revoke behavior is unchanged; no new signal,
CLI flag, package script, route, or listener was added.

**Local evidence:** the focused five-file A7/serving suite passes `91` and skips
one POSIX parent-permission test on Windows; the same test remains active on
protected Linux Gateway CI. Gateway lint, type-check, and build each exit `0`.
On the final local tree, `scripts/test-all.ps1` exits `0` in `720.8s` with
`All local non-Revit tests passed`, and `scripts/test-ci.ps1` exits `0` in
`727.0s` with `All CI-safe revAgent engineering gates passed`. Root
`package-lock.json` remains blob-identical at
`b3d8df2755b2ead322f36100bc1c0fb177af082c`.

The scope checkpoint `96c117afd419b3e20b0f57a5088fe06ed018c657`
passed [CI 31817877971, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31817877971/attempts/1)
with both Engineering and Gateway jobs green, plus
[Gateway CI 31817877933, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31817877933/attempts/1).
The implementation candidate
`66f0fd9264afb9165e0b868d49b83ff18239a6d2` then passed
[CI 31825900958, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31825900958/attempts/1)
with both Engineering and Gateway gates green, including the `31m14s` RBP
conformance step, plus
[Gateway CI 31825900964, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31825900964/attempts/1)
under protected Node 24. No rerun was used. The docs-only evidence head still
requires its own protected checks; Claude review and merge remain planner-
gated.

**Red-attempt dispositions:** the first independent focused run passed `68/69`
and rejected only the shutdown test's manually cast bundle after the runtime
provenance guard was added. The fixture was corrected to traverse the real
projector. Independent semantic review then found three real-emitter gaps:
denied confirmations may carry null correlation IDs, pre-authority failed
invocations may carry `mutating:null`, and non-denied confirmation states must
be bound to the registry's confirm policy. Closed validation and positive/
negative emitter-shape tests now cover all three.

An independent concurrency review also proved that the former asynchronous
stdout write could become visible before its callback while the `5s` deadline
still won. The success sink was therefore replaced with the protected atomic
artifact and a synchronous terminal commit boundary. The first build of that
adapter failed only on two test-double `implicit-any` annotations; those test
types were fixed and the clean build passed. A separate full Gateway-package
diagnostic passed `483`, skipped `1`, and failed only
`batchDispatch` and `northMcpEndpoint` because the local Node `22.22.2`
installation had no `better-sqlite3` native binding. Neither failed file is in
the slice diff; both failures stopped at native module load before their test
logic. This unsupported local engine was not rerun or treated as release
evidence; protected Gateway CI owns the repository-required Node `24.14.1`
binding and must be green on the implementation head.

**Forecast / actual / variance:** `2.00h` / `2.50h` / `+0.50h` (`+25%`)
active effort, calibrated against the prior M2 `-72%` variance. Passive
CI/review and operator waits are excluded.

**DNS route binding carried forward:** A6 is permanently canceled. Gate G2
presents on one operator screen: `m4-gateway.revagent.app -> 192.168.90.154`
as DNS-only (grey cloud), plus the exact `_acme-challenge` TXT value generated
by the certificate order. No Cloudflare API token will be generated or
requested. G7 must delete both A and TXT records and retain the operator's
positive confirmation. No DNS mutation is authorized by A7.

## M4-04/B bounded live session

**Gate state:** `blocked/partial`

**Planner decision:** the closing slices were assigned to the executor on
2026-08-17 after the planner accepted the M4-04/B closing report. This tracker
slice is the first of **two** authorized closing slices; the permanent source
fix is the second. Every other finding surfaced during closure is a Park item,
not a slice.

**Parking rule, set by the planner on 2026-08-17.** A finding surfaced during
closure or review does not automatically become a slice. The test is whether it
opens the chain toward the milestone's acceptance criterion; if it does not, it
goes to the Park List and is reassessed at M4 close. This record follows that
rule, and the Park List below is the destination for the items it names.

**Scope of record:** protected source is
`e9246cd1d51791db970bad800e6d2de418f5fc02` (`PR #380` squash merge), the exact
commit the live session was pinned to. This slice records the outcome of the
bounded live session that ran `T0 -> G2 -> G3 -> G4A -> G4B -> G5 -> G7` across
`revagent` (Gateway) and `PETRUCCI` (client/Bridge/add-in/Revit): the gates that
passed, the head finding that blocked `G5`, the acceptance-versus-reality and
card-versus-code differences, the product-requirement outputs, the environment
findings, the residue declaration for all three machines, and the open items.
It sets `M4-04` to `blocked/partial` and leaves the `M4` milestone row at
`in_progress`, because only the milestone decision owner may move a milestone
state.

**Explicitly out:** every executable surface. This slice performs no host,
image, container, network, DNS/TLS/ACL, credential, enrollment, revoke, broker,
client, Revit, reboot, write/confirm, workflow, runner, CD, signing, or NAS
action, and changes no product source. The permanent source repair of the
handoff read-then-assert ordering and the coordinator command construction is a
separate slice and must not appear in this diff. The repaired coordinator copy
staged on the coordinator workstation during the live session must not enter the
repository through this or any tracker slice.

The path allowlist is `docs/plan/M4_GATE_EVIDENCE.md` and
`docs/plan/MASTER_PLAN.md` only. No source, test, manifest, lockfile, workflow,
installer, or decision-record file is in scope. Root `package-lock.json` must
remain blob-identical.

**Evidence basis:** the live session's hash-chained evidence package is retained
on the coordinator workstation `DESKTOP-OKNV128` as deliberately retained
evidence, not repository content. This record cites its files by name and
SHA-256 so the chain stays verifiable without importing any of its bytes. No
secret value, credential byte, or DPAPI blob is reproduced here.

### Session gate names mapped onto the repository's seven gates

The live session ran under session-local card names (`T0`, `G2`–`G7`). Those
names exist only in the session package; `G3`–`G6` appear in no repository file.
The repository's canonical seven are enumerated earlier in this document. The
mapping below is what makes this record readable without the session package.

| Session name | Repository gate | Outcome |
|---|---|---|
| `T0` | baseline for `CLIENT-PLACEMENT/FEASIBILITY` | active-session feasibility proven — Revit open with a document, Codex running |
| `G2` | `DNS/TLS-TRUST` | `passed`, then fully reversed at `G7` |
| `G3` | `NETWORK/ACL` | `passed` as configured; never traversed |
| `G4A` | `BRIDGE-STAGE` | `passed` on retry |
| `G4B` | **not a repo gate** - session-local broker sub-step | broker staged and proven healthy; never run live |
| `G5` | `CREDENTIAL/ENROLL` | **blocked** by a product defect |
| `G6` | `CLIENT/LIVE` | **never opened** — out of scope once `G5` blocked |
| `G7` | `CLEANUP/RESIDUE-EQUALITY` | `passed` |

Two mappings are deliberately not one-to-one and are stated rather than forced.
`T0` is a baseline snapshot, not one of the seven; it closed the active-session
feasibility question that `CLIENT-PLACEMENT/FEASIBILITY` had left open. `G4B`
staged the client-side broker, which belongs to `CLIENT/LIVE`, so it is a
precondition of that gate rather than a gate of its own — `CLIENT/LIVE` itself
remains untouched.

`M4-WRITE-CONFIRM` was not approached at any point in this session.

### Gate chain outcome

| Gate | Outcome | Evidence record (SHA-256) |
|---|---|---|
| T0 | `passed` after two recorded stops (clock skew, Revit not open) | `T0-CLOSED-2026-08-15.md` `2a2d483a…` |
| G2 DNS/TLS trust | `passed` | `G2-DNS-TLS-TRUST-2026-08-15.md` `6813f767…` |
| G3 network/ACL | `passed` (configured; see the qualification below) | `G3-NETWORK-ACL-2026-08-15.md` `cc333b0b…` |
| G4A Bridge stage | `passed` on retry, after two independent defects | `G4A-BRIDGE-STAGE-PASS-2026-08-15.md` `839659b6…` |
| G4B broker stage | `passed` after Codex baseline re-anchoring | `G4B-BROKER-PASS-2026-08-15.md` `a70a8b35…` |
| G5 credential/enroll | **blocked by a product defect; partial closure** | `G5-SOURCE-LEG-DEFECT-2026-08-16.md` `d4fb18f8…` |
| G6 client/live | **out of scope; never opened** | — |
| G7 teardown/residue | `passed` | `G7-RESIDUE-EVIDENCE-2026-08-17.md` `f0709d55…`, `G7-FINAL-RESIDUE-CLOSURE-2026-08-17.md` `8ead45ec…` |

**M4-04 is therefore `blocked/partial`, not `passed`.** Two qualifications are
part of the result and are not omitted:

- **G3 is proven configured and never traversed, not proven effective under
  load.** The final `DOCKER-USER` counters read `ACCEPT 0 pkts / 0 bytes` and
  `REJECT 0 pkts / 0 bytes` immediately before the rules were deleted. No packet
  ever reached `192.168.90.154:443`. The rules were verified by construction and
  by a port-22 source-attribution proof, not by an allowed-versus-denied
  connection on `443`.
- **The four socket must-proves carried verbatim from G4A into G5 were never
  exercised**, because no Gateway container was started and no socket was opened.
  They remain must-proves and are entry conditions for the next bounded session.

What G5 did complete: phase-1 generation succeeded and validated
(`credentials.json` `852923bd…`, `north-bearer.bin` `f3b21432…`, three secrets of
`48` bytes each), the pre-secret egress proof, the destination-root owner repair
with `11/11` validator gates passing, and the coordinator repair. What it could
not complete: any secret handoff, therefore no Gateway serving start, no A5, and
no registration commit. The `600s` TTL never started.

Ceiling accounting: five coordinator invocations, of which four were null under
the planner's four-part test and the fifth (`2026-08-16T16:21:18Z`) spent
ceiling slot `1`. Slots `2` and `3` were deliberately left unspent once the
defect was proven deterministic.

### Head finding — the handoff source destroys the secret and then refuses to emit it

In `packages/gateway/src/preProductionSecretHandoff.ts`, the source main reads
and unlinks the allowlisted leaf inside `readSourceBytes`, and only afterwards
calls `assertRootUnchanged`. That check compares `mtimeMs`, `ctimeMs` and `size`
of the handoff root through `sameState`. Removing a directory entry necessarily
mutates all three, so **the check can never pass after a successful read**: the
source consumes the secret, then refuses to emit it, on every invocation.

Measured with a synthetic `64`-byte payload; the real bearer was not involved
and the source's stdout was never retained:

```text
sourceExitCode      78
sourceStdoutBytes   0
sourceStdoutSha256  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  (empty)
stderr              {"ok":false,…,"code":"preproduction_secret_handoff_source_refused",
                     "reason":"root_changed_during_read"}
leafAfter           ABSENT
expected frame      91 bytes, sha e58857b9cd13bea4d3f253b476df51065bbe0720a25ec0834dcadbd2ca3b4e26
expected stream     92 bytes  (frame + the trailing 0x01 control byte)
observed            0 bytes
```

Both kinds are affected. The same `runSource` serves `north_bearer` and
`enrollment_artifact`; `--kind` selects only the filename, so the identical
ordering applies and the enrollment handoff would have failed the same way.

The bearer **value** was not lost: `north-bearer.bin` is a copy of `secrets[0]`
and the same value remained in `credentials.json`. What was destroyed is the
dedicated handoff endpoint copy. The value-free constraint held throughout — the
bearer was never tee'd, logged, or captured.

The defect runs inside the immutable Gateway image, not as a script on disk, so
repair requires a source change plus an image rebuild. That produces a new digest
and invalidates the pinned `approvedLiveSelector` identity the whole M4-04/B
package is bound to, which is why it was not repaired in-session.

The minimal correct fix, recorded for the separate repair slice:
`assertRootUnchanged` should compare only identity-stable root fields —
`directory`, `symbolicLink`, `dev`, `ino`, `mode`, `uid` — and must exclude
`mtimeMs`, `ctimeMs`, `size` and `nlink`, which the source's own authorised
unlink necessarily changes; or the root recheck should be taken before the
unlink. Either preserves the security intent without failing on the source's own
side effect.

### Three acceptance-versus-reality gaps

Each is on the M4 critical path, each was invisible to a green suite, and each
was visible on first contact with a real machine.

1. **Protected-root owner rule.** `ProtectedStore.TryValidateNarrowAcl` requires
   `owner == caller`, and the receiver carries the same rule. The broker calls
   `SetOwner(current)` whenever it creates a root itself, so its own tests never
   validate a root created by anyone else.
   `G5-DESTINATION-ROOT-OWNER-STOP-2026-08-16.md` `2eeaa412…`.
2. **Coordinator `System.Object[]` join.** `invoke-m4-secret-handoff.ps1` splices
   an array into an array literal, so `-join` stringifies it and the remote
   command begins with the literal `System.Object[]`. The A4 coordinator suite is
   recorded passing under both engines, so it cannot have exercised this string
   construction end to end. `G5-COORDINATOR-DEFECT-STOP-2026-08-16.md`
   `7ca5f641…`.
3. **Handoff source read-then-assert ordering** (the head finding). The injected
   `io` fake does not model directory metadata changing on unlink, so the suite
   passes green while the real filesystem fails every time.
   `G5-SOURCE-LEG-DEFECT-2026-08-16.md` `d4fb18f8…`.

### Five card-versus-code differences

Items 4 and 5 carry the numbers already assigned in the evidence chain.

1. **Four serving-container path literals.** The card's
   `--credential-file`, `--tls-key-file`, `--tls-cert-file` and
   `--enrollment-output-file` values resolve to paths that cannot exist; the
   generator writes under `runtime/secrets`, and the enrollment artifact must land
   at `runtime/handoff/enrollment.json` for the handoff to read it. Caught before
   generation. `G5-CARD-PATH-DEFECT-STOP-2026-08-16.md` `e0f8fe2a…`; resolved by
   the planner's Option B in `G5-PATH-AUTHORITY-2026-08-16.md` `37d9df2e…`.
2. **Undeclared prerequisite.** `runtime/handoff` must already exist as
   `0700 bt:bt`; the generator refuses to create or widen an unverified ancestor
   and the card does not mention it. Same record.
3. **Destination-root ownership.** The card specifies the DACL only; the code
   requires `owner == calling user`, and the elevated SSH session produced
   `O:BA`. Repaired under `G5-OWNER-AUTHORITY-2026-08-16.md` `2f793295…`.
4. **DPAPI leaf location.** `BrokerContracts.StoreFileName` plus
   `ProtectedStore.DestinationPath(root)` place the leaf at
   `<root>\north-bearer.dpapi`, not `store\north-bearer.dpapi`; no `store\`
   directory is ever created. G4B's absence proof had checked the wrong path and
   held only because both were absent. G7's residue proof was retargeted.
   `G5-GATE-CHAIN-AUDIT-2026-08-16.md` `6c42bae3…`. **Since proven by
   execution, not only by source reading:** on 2026-08-17 the real broker binary
   committed a synthetic handoff and created `north-bearer.dpapi` directly under
   the protected root, with no `store\` directory created
   (`SLICE2-E2E-PROOF-SUPPLEMENT-BROKER-2026-08-17.md`, `ea9cc6c3…`). An executed
   proof outranks a source reading and is cited as such.
5. **Coordinator source-command construction** (gap 2 above). Repaired under
   `G5-COORDINATOR-AMENDMENT-2026-08-16.md` `b407dc7b…`, recording the old and new
   SHA-256; confirmed by observation when the non-probe `docker run` count moved
   from `0` to `1`.

All five were found by verifying frozen-card literals against the protected
source **before** an irreversible step. Items 1–3 cost nothing, item 4 cost only
a mis-targeted proof, and item 5 cost four null invocations.

### Product-requirement outputs

**R1 — the client leg must speak an HTTP CONNECT proxy.** PETRUCCI reaches the
internet only through `192.168.90.10:6588`, and .NET resolved that proxy for both
attempt origins with `bypassed=False`. A port-22 A/B probe separated the paths by
measurement: with the proxy honoured `revagent` saw `192.168.90.10` in `103ms`;
with it bypassed it saw the allowlisted `192.168.90.122` in `17ms`
(`G5-PREGEN-EGRESS-PROOF-2026-08-16.md` `4101b490…`). Had G5 fired as carded, the
broker's traffic would have arrived from the proxy address, hit the G3 REJECT
rule, and failed three must-proves **after** the single-shot secret had been
generated. A pilot workstation with no direct `443` egress is the normal case, so
the product client must transit a system- or WPAD-configured CONNECT proxy,
including authenticated ones. The per-process `NO_PROXY` used in the session is a
lab fix and is not a product requirement. Proposed for M5/M6 scope.

**R2 — one client-clock dependency exists in the auth chain.**
`packages/bridge/src/RevAgent.Bridge/Enrollment/BridgeEnrollmentArtifactConsumer.cs`
refuses an enrollment artifact outside a two-sided window measured against the
**consumer's own** clock: `MinimumRemainingLifetime` is `50s` and
`MaximumRemainingLifetime` is `24h + 5s`, both compared to
`_timeProvider.GetUtcNow()`. With the carded `600s` Gateway TTL a client running
fast fails closed once its clock passes `TTL - 50s`; the absolute bound is
`550s`, and after the elapsed time of the A5 step inside the `180s` window the
real tolerance is roughly `370s`. This is not theoretical: the uncorrected client
skew measured at T0 in this session was `228.97s`, within a factor of about `1.6`
of that tolerance, on a machine that cannot reach NTP because UDP `123` is
restricted.

There is no second line of defence. `nonce` does not occur anywhere in
`packages/gateway/src` under a case-insensitive search; the single `replay`
occurrence is journal terminal-state handling, not auth replay protection.
Freshness rests on the timestamp window alone.

Clean by contrast, and recorded as positives: the north bearer is an opaque
`64`-character token whose validator has no time component; the M4 handoff frame
carries no timestamp; and `preProductionIdentity.ts` evaluates `issuedAtMs` and
`expiresAtMs` against the Gateway's own clock, which is server-authoritative and
correct as written.

Proposed for M5/M6 scope: server-authoritative time plus a server-issued
nonce/challenge, so no client-clock reading decides an authorization outcome.
Until then the `<= 2s` two-host pair requirement remains an evidence-correlation
convenience, never a product requirement. This audit covers the surfaces present
in the pinned package; it is not a forward audit of M5/M6 OAuth.

### GAP-14 — mechanism demonstrated

A Codex Desktop self-update replaced `~\.codex\config.toml` wholesale at
`2026-08-15T12:50:29Z` (`2d285a88…` -> `fd062771…`, creation equal to last-write).
The AppX package full name, the Codex CLI image digest, and the Authenticode
signer thumbprint were all byte-identical afterwards, so this was an in-app
component refresh, not a package upgrade. The A4 caller-authorization tuple
survived intact, and PETRUCCI lost no capability because the file held no
revAgent sections there. `G4B-CODEX-BASELINE-ADDENDUM-2026-08-15.md` `a21c67b0…`.

What outlives M4: on a fleet workstation that does carry
`[mcp_servers.revAgent]` and `[mcp_servers.revAgent-api-docs]` — exactly what the
WP9 remote MCP registration commits at M9 cutover — the same path drops them
silently with no error surfaced to the user. GAP-14's existing emergency-patch
mitigation should be extended with a detection step and a documented one-command
idempotent re-registration. That disposition belongs to WP3/WP8 and is outside
this slice's allowlist.

### Environment findings for the lab-baseline lane

These are office-lab facts. They are ops records and must not become product
requirements.

- PETRUCCI had no working DNS resolver at all; it was repaired permanently to
  `192.168.90.3` (`OPS-PETRUCCI-DNS-2026-08-16.md` `50c58161…`).
- All PETRUCCI internet traffic transits `192.168.90.10:6588`; product
  consequence is R1.
- UDP `123` is restricted, so W32Time cannot resync and the clock free-runs at
  about `8ms/hour` after one manual set; product consequence is R2.
- `@(<System.Collections.Generic.List[object]>)` throws `ArgumentException` on
  both PETRUCCI and the coordinator workstation, under Windows PowerShell
  `5.1` and PowerShell Core `7.6.5`, via `-File` and via stdin, under any
  `StrictMode` and any culture. It is specific to a generic list whose element
  type is exactly `System.Object`; an empty list fails too. `.ToArray()`,
  `[object[]]`, `ArrayList` and typed lists are unaffected. Automation targeting
  these hosts must not use that construct.
- `-match` disagreed with `[regex]::IsMatch` on an identical string and pattern
  (`-match=False`, `IsMatch=True`) for a string proven to be exactly `64`
  characters of `[A-Za-z0-9_-]`. Any security-relevant use of `-match` on these
  hosts should be reviewed. `G5-SYNTHETIC-DESTINATION-DIAG-2026-08-16.md`
  `9136a3da…`.
- Framed base64 over the SSH channel truncates silently past roughly `44KB`, and
  the stdin channel went intermittently silent; both were resolved with an
  archive plus `scp` and with file plus `-File`.

### Three-machine residue declaration

- **`revagent`:** clean. No attempt file, image, network, rule, listener, or DNS
  record remains; images are exactly the two preserved tags, networks are exactly
  `bridge host none`, `DOCKER-USER` is bare, UFW is inactive, and the four
  `/opt/revagent/deploy/phase1` hashes are identical before and after. The one
  deliberate retention is `timedatectl set-ntp true`, applied under T0 authority.
- **`PETRUCCI`:** clean. All seven attempt paths absent, `C:\revagent-deploy`
  intact at `45` children, `10` M3-era bundle directories preserved,
  `revAgentBridge` `Running/Auto/LocalSystem`, all four baseline hashes equal,
  listeners `0/0`, and no DPAPI leaf. The interface DNS repair to `192.168.90.3`
  is deliberately permanent and is an ops record, not a product requirement.
- **Coordinator workstation `DESKTOP-OKNV128`:** what remains is deliberately
  retained evidence, not residue — the evidence chain, the automation scripts,
  the value-free export, and the extracted comparison tree. **The repaired
  coordinator copy staged there must not enter the repository**; the permanent
  fix is a separate slice. No secret value, credential byte, or DPAPI blob was
  ever written to this machine; the export rule excluded every backup byte and
  recorded those files by hash only.

DNS absence is proven from three vantages: the record resolved to
`192.168.90.154` before deletion, then returned `NXDOMAIN` from the office
resolver `192.168.90.3` at `2026-08-17T12:06:19Z` and from both `1.1.1.1` and
`8.8.8.8` at `2026-08-17T12:11:33Z`, each against a control name that resolved
normally. The Revit sample model hash is byte-identical to T0, which proves the
model file was never rewritten.

The only acknowledged remaining external residue is public CA/CT history and the
unrevoked certificate recorded in the Park List.

### Open items carried out of the session

1. **The certificate was not revoked.** Serial
   `067FEA2F97ED511AD57E74DEE5D8B0410507`, SAN `m4-gateway.revagent.app`, valid
   through `2026-11-13T12:10:03Z`. The ACME account key was destroyed by an
   ordering fault in the executor's teardown script before revocation was
   attempted, and `lego` supports only account-key revocation. RFC 8555 §7.6
   permits certificate-key revocation; that path was deliberately declined rather
   than unavailable, to avoid installing unauthorized tooling on a host being torn
   down. Residual risk is bounded: the private key is destroyed with positive
   proof, the SAN returns `NXDOMAIN`, and the address it named is RFC 1918.
2. **Bridge staged-worker startup anomaly, never re-measured.** In one identical
   context the incumbent worker reaches `worker_ready` in `0.330s` while the
   staged worker needs `12.519s`, and a first-sight scan cannot explain it. It was
   carried into G5 as a free re-measurement item, but G5 never reached the Bridge
   restart. `12.519s` stays inside the `30s` `StartupTimeout`, so this is a
   performance question, not a correctness one.
3. **Destination refusal shape at `16:21` is undetermined.** The coordinator holds
   the destination's stdout internally and collapses every downstream failure to
   `cleanup_uncertain`, so a refused frame and a failed metadata shape are
   indistinguishable. Moot for this image, but the opacity itself is worth
   repairing: four null invocations were spent because the coordinator could not
   say what failed.
4. **An operator-specific SSH key path is documented as if it were general.**
   Six occurrences across `docs/DEVELOPER_RUNBOOK.md`, `README.md`, and
   `installer/nas/README.md`. Cosmetic, blocks nothing; parked for reassessment
   at M4 close rather than opened as a slice.

**Forecast / actual / variance:** `1.50h` / `1.00h` / `-0.50h` (`-33%`) active
effort for this tracker slice. Passive CI, review, and planner waits are
excluded. The live session itself is not counted here; it ran under its own
bounded authorization across 2026-08-15 to 2026-08-17.

**Working-tree disposition recorded with this slice.** The repository had been
left with one uncommitted and one untracked file since before the live session.
`docs/plan/MASTER_PLAN.md` carried `82` insertions that were a superseded earlier
state of the M2/M3 checkpoints already merged and accepted on `main`; keeping
them would have reverted `235` lines of accepted content, so they were discarded
after a byte-level comparison proved every unique line was an older form of
content `main` already carries. `docs/REVAGENT_FIVE_RUNNER_WINDOWS_PILOT_RUNBOOK.md`
is not on `main`, is not part of any M4 slice, and was left untracked and
untouched for its own owner to dispose of. Both files were backed up before the
working tree was returned to `main`. No commit, amend, reset, or push touched the
repository during the live session itself; that was verified by reflog before
this slice opened.

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
  `gateway.revagent.app` or start its connector; the production tunnel records
  were verified untouched and still proxied after the session. The separate test
  FQDN, DNS-only private-address record, trusted-CA DNS-01 certificate, and
  manual A/TXT creation were **executed and then reversed** in M4-04/B: the
  operator created both records at G2 and deleted both at G7, and their absence
  is proven from three independent resolvers. A6 remained permanently canceled
  and no Cloudflare API token was generated or requested. The unrevoked
  certificate is a Park item.
- **M4-CLIENT/LIVE:** external client, real tenant/OAuth flow, live Gateway
  exchange, and live Revit execution remain separately operator-gated. M4-04/B
  did not reach them: G6 was taken out of scope when G5 blocked, no Gateway
  container was ever started, and no packet reached the Gateway's `443`.
- **M4-04/B handoff defect:** the pre-production secret handoff is non-functional
  in the pinned image for both `north_bearer` and `enrollment_artifact`. Until
  the separate repair slice lands and a rebuilt image is pinned, no bounded
  session can complete G5. The rebuild produces a new digest and therefore a new
  package with new frozen cards, not a continuation of M4-04/B.
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
  The M4-04/B image built from exact source
  `e9246cd1d51791db970bad800e6d2de418f5fc02` reports the same
  `2 moderate / 1 high` in its shipped runtime stage, and `3 moderate / 4 high`
  in its build stage. Build-log evidence SHA-256
  `d8f66ee59817451c35e9273a3656a24a72804791595f0587ddf674255a0bc153`. The
  disposition is unchanged and still requires a separate planner-bound decision
  before the M5 security/auth lane; the runtime finding should be cleared as part
  of the image rebuild that carries the handoff repair, rather than as an
  independent dependency change.
- The certificate issued for the M4-04/B session was **not revoked**. Serial
  `067FEA2F97ED511AD57E74DEE5D8B0410507`, SAN `m4-gateway.revagent.app`, valid
  through `2026-11-13T12:10:03Z`. Its private key was destroyed with positive
  proof, its only SAN now returns `NXDOMAIN`, and the address it named is RFC
  1918, so the residual exposure is bounded; public CT history is immutable and
  is acknowledged as permanent external residue. This is a non-blocking Park item
  and needs no further action unless the planner decides otherwise.
- The Bridge staged-worker startup anomaly (`0.330s` incumbent versus `12.519s`
  staged, same host and service) is unexplained and was never re-measured because
  G5 did not reach the Bridge restart. It stays inside the `30s`
  `StartupTimeout`, so it is a non-blocking performance Park item; the next
  bounded session gets the measurement for free.
- The `Gateway CI` secret-scan step is fail-closed on an API call it does not
  need. `gitleaks-action`'s `ScanPullRequest` path calls
  `/repos/{owner}/{repo}/pulls/{n}/commits`; when that endpoint is unavailable
  the action crashes before scanning anything, every later step is skipped, and
  the whole job fails while reporting a secrets-scan failure that never happened.
  Observed on 2026-08-17 during a GitHub platform incident. `fetch-depth: 0` is
  already configured, so a local range scan would remove the dependency
  entirely. Real fragility, but it blocks nothing on the critical path: parked
  for reassessment at M4 close.
- An operator-specific SSH key path (`C:\Users\BT\.ssh\id_ed25519`) is documented
  as if it were general in six places across `docs/DEVELOPER_RUNBOOK.md`,
  `README.md`, and `installer/nas/README.md`. Cosmetic; parked.
- **Cross-platform handoff gate.** The handoff source refuses to run on Windows
  and the receiver is `net8.0-windows`, so the two legs cannot execute on one
  host and no single CI lane can prove the wire contract end to end. Standing
  in-repo coverage is the exact-stream assertion; a one-off two-environment
  proof is recorded in `SLICE2-E2E-PROOF-2026-08-17.md`; the live end-to-end
  belongs to the next bounded session. Unparking trigger, verbatim:
  *"if either leg's framing changes again, or if a third cross-implementation
  drift is found, build the two-lane CI gate."*
- **Handoff destroy-then-deliver ordering - fail-closed by design; assess
  retry/idempotent regeneration semantics before M5 OAuth.** The source unlinks
  and proves absence of the leaf before the frame is written, so any failure
  after the unlink destroys the secret rather than duplicating it. That is the
  correct security direction and it is deliberately unchanged, but it is also
  what burned the north bearer at `16:21` and forced an authorization-ceiling
  raise. In production a secret that dies on any transport hiccup is an
  availability problem, not only a security posture.

## Submission rule

M4-02's bounded repo and authorized-host evidence is complete, the slice is
`passed`, and `PR #370` merged as `55a34032`. M4-03/A passed and `PR #372`
merged as `9b7ead13`; its merge-push CI is green. M4-CREDENTIAL/B also passed its
separately approved exact-source target-host execution and positive cleanup.
The M4 milestone ledger stays `in_progress` / `not_submitted` because
M4-CLIENT/LIVE, M4-WRITE-CONFIRM, RES-30, and the remaining planner-bound slices
are still open. No evidence result becomes milestone acceptance without the
milestone owner's explicit decision.

M4-04/A7 has since merged as `e9246cd1`, and the bounded M4-04/B live session ran
against exactly that source. M4-04/B is `blocked/partial`: T0, G2, G3, G4A and
G4B passed, G5 was blocked by a product defect inside the pinned image, G6 was
taken out of scope, and G7 completed with a proven-clean residue state on both
live hosts. That result does **not** move the M4 milestone ledger, which remains
`in_progress` / `not_submitted`; only the milestone decision owner may change a
milestone state, and this record makes no such claim.

The M4 live path cannot be completed on the pinned image. Closing it requires
the separate repair slice, a rebuilt image with a newly pinned digest, and a new
bounded session carrying the four unexercised socket must-proves, the corrected
serving path literals, destination-root ownership set at creation, the
`<root>\north-bearer.dpapi` leaf location, and the R1 proxy reality.
