# revAgent Signed Source-Free CD Rollout Plan

This is the active rollout plan after the source-free package implementation.
The goal is to move the release pipeline toward GitHub Actions CD while keeping
the first production deployment target as the existing NAS release channel.

This plan is not a user-data privacy boundary. It protects revAgent source
know-how, package origin, and production rollout control. Workstation Codex
sessions, memory, project context, live Revit model data, workbook contents,
and raw telemetry stay outside the CD pipeline unless a separate approved
design changes that boundary.

## Current Baseline

- Source-free user pack, JavaScript hardening, managed debug-symbol stripping,
  know-how boundary review, distribution-integrity primitives, optional
  license-seat verification, source-free migration tooling, signed-stable
  readiness preflight, GitHub Actions signed source-free CD, production
  signing/NAS publish automation, self-hosted CI/CD runners, developer
  `preserve-local` Codex instruction policy, and GUI migration bootstrap for
  older local updater toolchains are implemented.
- `main` is the development and release source of truth.
- Protected `main` updates build, sign, and validate a signed source-free
  release root through `.github/workflows/signed-source-free-cd.yml`; they do
  not publish to NAS stable by themselves.
- Production NAS stable publish requires explicit manual workflow dispatch with
  `publish_to_nas=true`. Normal forward publish keeps `allow_rollback=false`,
  and the publish job waits for required commit gates before replacing
  production `stable.json`.
- The current production NAS stable channel is signed and source-free, but it
  may lag future `main` changes. Verify the live `channels\stable.json`,
  release manifest, ZIP hash, release sequence, and CD run before instructing
  operators to update workstations.
- Point-in-time NAS stable verification snapshot recorded on 2026-06-29 after
  PR #142:
  - CD publish run:
    `https://github.com/BTankut/revit-mcp-skill/actions/runs/28399758304`
  - stable version: `2026.06.29.452-7bde7d6b`
  - stable commit: `7bde7d6ba4fde59830bd100e1e9307d4c3070532`
  - release sequence: `20260629201953`
  - package SHA256:
    `D13AF3411917E263CA1A83DC0D586400DAB6B8E671E5440F92BCAE5A1AC50624`
- Office rollout is in cleanup/verification. Stable has advanced to 452 and
  operator-driven workstation updates are in progress. Final rollout is not
  considered closed until every in-scope workstation has a current update
  report and a source-free dry-run inventory of zero managed source/developer
  artifacts. Machines intentionally out of scope, such as retired/offline
  workstations, must be recorded as excluded instead of left ambiguous.
- Use `scripts\check-rollout-readiness.ps1` as the current read-only closure
  audit. It combines NAS stable metadata, machine reports, source-free
  migration evidence, copied logs, and live heartbeat freshness into a
  per-machine action list without updating or connecting to any workstation.
  Use `config\rollout-readiness.sample.json` as the template for a local or
  NAS-side config that records the expected machine list and any intentionally
  out-of-scope workstation reasons. The same audit also reads current-stable
  live Revit smoke evidence from config `liveSmokeEvidence` or
  `reports\rollout\live-smoke-latest.json` and reports a rollout-level action
  until a passing smoke record matches the current stable version or commit.

This snapshot is archival. Before taking rollout action, re-verify the live
NAS `channels\stable.json`, release manifest, ZIP hash, signed-stable
readiness, latest CD run, and current machine reports rather than treating
these values as current truth.

## Security Roadmap Boundary

The current rollout priority is source-code exposure reduction: release
packages must be source-free, workstation installs must not receive repository
or source files, and update/migration must keep that boundary intact.

Advanced supply-chain hardening is deferred to the later commercial security
track defined in `REVAGENT_DISTRIBUTION_INTEGRITY_PLAN.md` under
`Commercial Security Roadmap Boundary`. Those items are not blockers for the
current source-free user-pack rollout.

## Deployment Direction

Use GitHub Actions as the CD producer, but do not let workstations install or
update directly from the private source repository.

Initial target:

1. GitHub Actions builds and validates a signed source-free release artifact.
2. A manual GitHub Actions dispatch with `publish_to_nas=true` publishes that
   exact signed release to the existing NAS release layout after a protected
   `main` update. The normal code path is PR review, required checks, Claude
   review on PR updates, and merge.
3. Workstations continue to read the NAS channel while the signed-stable
   baseline, source-free migration, and fail-closed updater behavior are phased
   into the office machines.

Later target:

- Add a provider-neutral deployment layer so the same signed release can be
  published to NAS, a binary-only GitHub Releases repository, or an object
  storage endpoint without changing package semantics.

Rejected initial target:

- Do not distribute workstation update credentials that grant read access to
  the private source repository. Private GitHub release asset access requires
  repository read-style access, which conflicts with the source-protection goal
  if the source repo itself is the workstation download source.

## Open Items

- Close the office rollout audit:
  - update any in-scope workstation that is not on the current NAS stable;
  - run or collect a source-free migration dry-run report showing zero managed
    source/developer artifacts on each in-scope workstation;
  - collect at least one current live Revit smoke result after the stable update
    and record it as readiness smoke evidence;
  - mark retired or unreachable machines as intentionally out of scope in the
    rollout readiness config with a short reason.
- Keep the dashboard interpretation explicit: `Offline` is live MCP heartbeat
  freshness, not update success; version/update state comes from machine
  install/update reports.
- License or seat verification exists but remains optional and disabled by
  default; no production entitlement enforcement is active.
- .NET obfuscation is not shipped. It remains a separate source-exposure
  reduction workstream after the signed source-free rollout is stable and a
  Revit 2022 live model smoke test is available.
- Migration rollback robustness remains a productization reliability follow-up;
  current rollout relies on dry-run inventory, one-time commit, and post-run
  validation rather than a fully transactional workstation rollback.
- GitHub environment reviewer/wait-timer protection rules are unavailable on the
  current GitHub plan; the operator gate is therefore protected PR review,
  required checks, and the explicit merge decision.
- The daily workstation scheduled task can consume stable before a manual
  operator rollout message. To hold a release, keep it off NAS stable or disable
  `revAgent Auto Update` on the affected machines before manual NAS publish.
- Any remaining NAS report/log publish warnings are share/report-write
  operational issues. They do not change signed package verification, but they
  must be resolved if they hide machine audit evidence.

## Current Execution Position

The repository implementation is through Phase 6 for the current office
source-free rollout. The remaining current-track work is operational closure:

1. Re-verify the live production NAS stable root before each rollout action.
2. Bring every in-scope workstation to the current stable or record it as out of
   scope.
3. Collect machine reports, source-free inventory evidence, and representative
   live Revit smoke evidence after the final stable update.
4. Run `scripts\invoke-rollout-closure-audit.ps1` and clear its action list.
5. Then close the source-free office rollout and leave Phase 7 as the separate
   optional entitlement/obfuscation track.

Phase 7 remains optional and separate. License enforcement, obfuscation, and
commercial supply-chain hardening are not required to publish or finish the
current office source-free user pack.

## Repository Implementation Status - 2026-06-26

Implemented in this repository:

- GitHub Actions CD producer workflow:
  `.github/workflows/signed-source-free-cd.yml`.
- Signed release producer wrapper:
  `scripts/invoke-signed-source-free-cd.ps1`.
- Local-staging NAS publish wrapper:
  `scripts/publish-signed-source-free-release-to-nas.ps1`.
- Read-only office rollout closure audit:
  `scripts/check-rollout-readiness.ps1`.
- Timestamped closure snapshot wrapper:
  `scripts/invoke-rollout-closure-audit.ps1`.
- Portable signed metadata: new release channel and manifest package paths are
  relative so a signed CD artifact can move from staging to NAS without
  rewriting signed JSON.
- Public trusted release key propagation:
  `publish-nas-release.ps1 -TrustedReleaseKeysPath` copies the public key set to
  `tools\config\release-trusted-keys.json`.
- Signed-stable readiness now verifies signatures, package hash,
  `releaseSequence`, private-key absence, and source/developer/debug artifact
  absence across the release root and ZIP.
- CI-safe coverage:
  `scripts/test-signed-source-free-cd.ps1` validates the producer and temp NAS
  publish wrappers, and `scripts/test-ci.ps1` runs it.
- Production publish gate:
  production `workflow_dispatch` waits for required commit checks such as
  `Engineering gates` before publishing to NAS.
- Developer workstation preservation:
  `codexInstructionPolicy=preserve-local` and optional
  `machineRole=developer` preserve local developer Codex instruction files
  while keeping runtime, Revit payload, signing, reporting, and migration
  cleanup active.
- GUI migration bootstrap:
  when source-free migration is required but the installed local updater is too
  old to support `-SourceFreeMigration`, the GUI runs the installer bootstrap
  with `-RunSourceFreeMigration` after operator confirmation.

Chosen CD model:

- Build/sign runs from `main` on an office-controlled self-hosted Windows
  runner behind the protected `revagent-release-signing` environment.
- The private release signing key stays as a local runner file outside Git and
  outside NAS `tools`; GitHub receives only the path, key id, and public trusted
  key file path.
- NAS publish is a separate job behind the protected
  `revagent-production-publish` environment. It runs only when the workflow is
  manually dispatched with `publish_to_nas=true`.
- The publish job uses the validated release root staged locally under the
  self-hosted runner workspace; it does not rebuild or re-sign. This avoids
  GitHub artifact storage quota, but it means the selected runner labels must
  resolve to the office runner that owns both signing-key and NAS access.
- NAS candidate/stable readiness uses active-release artifact hygiene so the
  new signed source-free release and current `tools\` payload are enforced
  without blocking on historical source-full ZIPs already present in the
  existing NAS release archive. Historical archive cleanup remains a separate
  maintenance task.

Operational setup status:

- Production release signing key material was created on this workstation,
  outside Git and outside NAS `tools`:
  - key id: `revagent-prod-rsa-2026q3`;
  - private key path:
    `C:\ProgramData\DPE\revAgentReleaseSigning\private\revagent-prod-rsa-2026q3-private.xml`;
  - public trusted key path:
    `C:\ProgramData\DPE\revAgentReleaseSigning\public\release-trusted-keys.json`;
  - public key fingerprint:
    `32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33`.
- GitHub Actions environments now exist:
  - `revagent-release-signing`;
  - `revagent-production-publish`.
- Required environment variables are configured with paths/key id:
  - `REVAGENT_RELEASE_SIGNING_PRIVATE_KEY_PATH`;
  - `REVAGENT_RELEASE_SIGNING_KEY_ID`;
  - `REVAGENT_TRUSTED_RELEASE_KEYS_PATH`;
  - `REVAGENT_NAS_RELEASE_ROOT`.
- GitHub environment reviewer/wait-timer protection rules could not be enabled
  on the current repo plan; the GitHub API returned billing-plan 422 errors for
  those protection-rule requests. Until the repo plan supports protected
  environment reviewers, the explicit operator gate is the protected PR
  review/CI/merge decision for `main`; after merge, signed CD validates
  automatically, and production NAS publish requires manual workflow dispatch
  with `publish_to_nas=true`. The script-side candidate-readiness guard still
  runs before `stable.json` is replaced.
- A no-publish local CD smoke using the production signing key succeeded and
  produced signed `stable.json`, `stable.sig.json`, `manifest.json`,
  `manifest.sig.json`, a positive `releaseSequence`, and a readiness-verified
  release root in a temporary directory that was deleted after verification.
- A self-hosted Windows runner was registered for this repo with the
  `revagent-cd` label on the office workstation.
- PowerShell 7 was installed for the runner because the workflow uses `pwsh`.
- Signed source-free CD has run from protected `main` in build/validate mode
  and has published production NAS stable by manual workflow dispatch. The
  workflow uses local self-hosted runner staging for the signed release-root
  handoff instead of GitHub artifact storage.

Still open after CD/NAS automation:

- Use `Current Execution Position` as the source of truth for the next
  operational rollout steps.
- Finish machine-by-machine rollout audit evidence for the current stable.
- Record any intentionally excluded workstation instead of leaving stale
  dashboard entries ambiguous.
- Returning to entitlement, obfuscation, and commercial supply-chain
  hardening as separate later workstreams.

## Phase 1 - CD Design And Key Decisions

Goal: make the next deployment step explicit before touching production NAS.

Status: complete for the current office rollout.

Required outcomes:

- Decide the production release signing model:
  - private key storage location outside Git and outside NAS `tools`;
  - key backup and recovery owner;
  - key rotation policy and key ID naming;
  - public trusted release key deployment path for workstations.
- Decide the initial GitHub Actions deployment trigger:
  - protected `main` push automatically builds, signs, and validates without
    publishing to NAS stable;
  - manual workflow dispatch from `main` with `publish_to_nas=true` is required
    for explicit operator-triggered production publish;
  - manual `allow_rollback=true` is reserved for signed rollback,
    same-sequence repair, or the one-time bootstrap over legacy stable metadata
    that has no `releaseSequence`.
- Decide whether signing happens inside GitHub Actions or on a self-hosted
  runner. Prefer a self-hosted runner if the private signing key or NAS access
  should never leave the office-controlled environment.
- Record the chosen model in the developer runbook before enabling production
  publish automation.

Gate:

- Production publish automation must not be enabled until signing-key handling
  and the protected PR/merge gate are documented.

## Phase 2 - GitHub Actions CD Producer

Goal: GitHub Actions can produce the same source-free signed release artifact
that the manual publish primitive can produce for fallback/recovery work.

Status: complete.

Required outcomes:

- Add a protected CD workflow that runs the existing non-Revit engineering
  gates before packaging.
- Build or validate the source-free user pack from a clean `main` checkout.
- Generate release manifest, channel manifest, detached signatures, package
  SHA256, and release sequence metadata.
- Run `scripts/check-signed-stable-readiness.ps1` against the produced release
  root before upload or NAS publish.
- Keep the produced release root in local self-hosted runner staging for the
  publish job handoff. Do not expose private signing material in logs or
  artifacts.

Gate:

- The workflow must fail if source files, source maps, `.pdb`, `.mdb`,
  developer manifests, private keys, or license secrets appear in the user
  package or release root.

## Phase 3 - CD To NAS Publish

Goal: GitHub Actions publishes the signed source-free release to the existing
NAS deployment layout without changing workstation updater behavior.

Status: complete for the NAS-backed path; provider-neutral publishing remains
the follow-up.

Required outcomes:

- Use a runner that can reach the canonical
  `\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy` root and, during the
  transition window, the legacy `revit-mcp-deploy` compatibility root.
- Publish to the existing NAS shape:

```text
channels\
  stable.json
  stable.sig.json
releases\
  <version>\
    manifest.json
    manifest.sig.json
    revit-mcp-skill-<version>.zip
tools\
```

- Refresh NAS `tools` from the same reviewed release state.
- Verify `stable.json`, `stable.sig.json`, release manifest, manifest
  signature, ZIP path, ZIP SHA256, and release sequence after publish.
- Keep code changes controlled by the protected PR review/CI/merge gate for
  `main`, then publish only by explicit manual workflow dispatch. Do not tell
  operators to run workstation updaters until the signed CD publish has
  completed and NAS `stable.json` points at the expected merge commit.
- Keep `allow_rollback=false` for normal forward publishes. Use
  `allow_rollback=true` only as an explicit operator decision for signed
  rollback, same-sequence repair, or first legacy stable bootstrap.

Gate:

- Do not update `channels\stable.json` unless the signed-stable readiness
  preflight passes on the exact NAS release root that workstations will read.

## Phase 4 - Signed Stable Baseline

Goal: publish one signed production stable release and move workstation updater
verification to fail-closed behavior wherever trusted release keys are present.

Status: complete for the current signed stable baseline. Continue verifying
machine reports during rollout.

Required outcomes:

- Production public trusted release key material is installed on pilot
  workstations before the signed stable update is expected to verify.
- NAS stable points to a fully signed release with positive `releaseSequence`
  in both channel and manifest metadata.
- Updater reports distribution-integrity status as signed and verified on pilot
  machines.
- Unsigned legacy compatibility remains available only for keys-free
  bootstrap/test paths; once a workstation has trusted release keys or any
  accepted signed sequence, unsigned stable metadata is rejected.

Pilot machines:

- Net01 was the initial signed/source-free pilot.
- Additional production-context workstations have consumed the signed stable.
  Treat pilot status as closed only when the current stable has source-free
  dry-run inventory evidence and live smoke evidence.

Gate:

- Do not close the office rollout or expand to a new deployment population until
  pilot and production-context reports confirm signed verification, local
  trusted key pinning, and no source/developer artifacts after update.

## Phase 5 - Fail-Closed Enforcement

Goal: require valid signed channel and release manifests before workstation
package replacement.

Status: implemented for machines with trusted release keys. Unsigned
compatibility is limited to keys-free bootstrap/test paths.

Required outcomes:

- Updater policy defaults to enforce when trusted release keys are present; no
  separate broad compatibility window remains after local trusted keys are
  installed.
- Missing, partial, invalid, tampered, unknown-key, fingerprint-mismatched, or
  replayed older signed releases are blocked before package replacement.
- Emergency rollback remains explicit, local-operator controlled, and audited.
- Failure reports clearly distinguish distribution-integrity guards from
  generic install failures.

Gate:

- Future key-policy changes still require a separate approved deployment step
  from ordinary signed stable publish.

## Phase 6 - Migration Rollout

Goal: move existing workstations from old source-carrying installs to the
source-free signed update path without damaging user Codex context.

Status: implemented and in operational closure. Existing source-carrying
installs can migrate through normal GUI flow; old local updater toolchains are
bootstrapped through `-RunSourceFreeMigration`.

Required outcomes:

- Run the migration tool in dry-run mode on each pilot class before commit.
- Confirm source/developer artifact inventory reaches zero after commit.
- Preserve user Codex sessions, memory, history, and active project context.
- Preserve previously disabled updater scheduled-task state unless an operator
  explicitly chooses to enable it.
- Keep local and remote reports for every migration run.

Gate:

- Close rollout only after in-scope machines have update reports, zero
  source/developer artifact dry-run evidence, preserved Codex context evidence
  where relevant, and at least one representative live Revit smoke check on the
  current stable.

## Phase 7 - Optional Entitlement And Obfuscation

Goal: evaluate additional copying-cost controls after the signed source-free
release channel is stable.

Status: deferred to a separate product/security-hardening track.

Required outcomes:

- License/seat enforcement remains disabled until support, grace policy,
  operator recovery, and public-key/token lifecycle are documented.
- .NET obfuscation is tested in a Revit 2022 live model before any production
  payload is shipped.
- Obfuscation must not break Revit add-in loading, command discovery, MCP
  bridge behavior, logging, support diagnostics, or rollback.

Gate:

- Treat entitlement enforcement and obfuscation as separate PRs and separate
  production approvals.

## Provider-Neutral Follow-Up

After the NAS-backed CD path is stable, add a deployment provider abstraction.

Candidate providers:

- `file` or `unc`: current NAS/channel layout.
- `github-release`: binary-only distribution repository, not the private source
  repository.
- `https`: object storage or signed URL endpoint.

The updater should continue to verify signed channel and manifest metadata
before trusting any provider.

## Operating Rules

- GitHub Actions may produce and publish user packs; it must not publish source
  archives as workstation install artifacts.
- Private signing keys, license-signing keys, seat secrets, and GitHub write
  tokens must not be stored in the repo, user ZIP, NAS `tools`, updater config,
  or workstation payload.
- Production publish is gated by protected branch controls plus explicit manual
  workflow dispatch. The normal path is PR review, required checks, explicit
  merge, then `workflow_dispatch` with `publish_to_nas=true`.
- NAS publish and fail-closed policy changes remain separate actions.
- Source-free packaging, distribution integrity, migration, and optional
  entitlement are separate layers. Do not use one as a substitute for another.
