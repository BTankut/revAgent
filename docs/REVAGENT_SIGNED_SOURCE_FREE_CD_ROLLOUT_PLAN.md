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
  license-seat verification, source-free migration tooling, and signed-stable
  readiness preflight are implemented and merged through PR #87.
- `main` is the development and release source of truth.
- No production NAS stable publish has been performed after PR #87.
- No production signed stable baseline has been published.
- Normal office update policy has not been flipped to fail-closed signature
  enforcement.
- Net01 has been used as the migration/source-free pilot machine; broad office
  rollout has not started.

## Deployment Direction

Use GitHub Actions as the CD producer, but do not let workstations install or
update directly from the private source repository.

Initial target:

1. GitHub Actions builds and validates a signed source-free release artifact.
2. GitHub Actions publishes that exact signed release to the existing NAS
   release layout after protected approval.
3. Workstations continue to read the NAS channel while the signed-stable
   baseline and fail-closed updater policy are phased in.

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

- Production NAS stable has not been updated with the post-PR #87 source-free
  and signed-release-ready package.
- Signed stable baseline has not been published in production.
- Fail-closed distribution-integrity enforcement is not enabled.
- Production release signing key management model is documented, but the actual
  production private key file, backup, GitHub environment variables, approvals,
  and public trusted key deployment still need to be created and verified.
- License or seat verification exists but remains optional and disabled by
  default; no production entitlement enforcement is active.
- .NET obfuscation is not shipped. It remains deferred until a Revit 2022 live
  model smoke test and deployment trust decision.
- Net01 pilot is successful, but multi-machine migration rollout has not been
  executed.
- NAS report/log publish warning from the pilot remains a separate share/report
  write issue.

## Repository Implementation Status - 2026-06-23

Implemented in this repository:

- GitHub Actions CD producer workflow:
  `.github/workflows/signed-source-free-cd.yml`.
- Signed release producer wrapper:
  `scripts/invoke-signed-source-free-cd.ps1`.
- Reviewed-artifact NAS publish wrapper:
  `scripts/publish-signed-source-free-release-to-nas.ps1`.
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

Chosen CD model:

- Build/sign runs from `main` on an office-controlled self-hosted Windows
  runner behind the protected `revagent-release-signing` environment.
- The private release signing key stays as a local runner file outside Git and
  outside NAS `tools`; GitHub receives only the path, key id, and public trusted
  key file path.
- NAS publish is a separate job behind the protected
  `revagent-production-publish` environment and is enabled only with
  `publish_to_nas=true`.
- The publish job uses the validated release root staged locally under the
  self-hosted runner workspace; it does not rebuild or re-sign. This avoids
  GitHub artifact storage quota, but it means the selected runner labels must
  resolve to the office runner that owns both signing-key and NAS access.

Still not executed by this repo change:

- Creating or installing a production private signing key.
- Setting protected GitHub environment variables and approvals.
- Publishing production NAS stable.
- Installing public trusted release keys on pilot workstations through a real
  signed stable update.
- Enabling fail-closed enforcement.
- Running multi-machine migration rollout.

External setup status after PR preparation:

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
  environment reviewers, the explicit operator gate is manual workflow dispatch
  plus `publish_to_nas=true`, followed by the script-side candidate-readiness
  guard before `stable.json` is replaced.
- A no-publish local CD smoke using the production signing key succeeded and
  produced signed `stable.json`, `stable.sig.json`, `manifest.json`,
  `manifest.sig.json`, a positive `releaseSequence`, and a readiness-verified
  release root in a temporary directory that was deleted after verification.

Post-merge setup status:

- PR #88 was merged into `main`.
- A self-hosted Windows runner was registered for this repo with the
  `revagent-cd` label on the office workstation.
- PowerShell 7 was installed for the runner because the workflow uses `pwsh`.
- A no-publish GitHub Actions CD run reached and passed the build/validate
  step from merged `main`. The first workflow shape then hit GitHub Actions
  artifact storage quota during `actions/upload-artifact`; the follow-up
  workflow uses local self-hosted runner staging for the signed release-root
  handoff instead of GitHub artifact storage.

Still not executed after external setup:

- Running the local-staging GitHub Actions CD workflow from merged `main`.
- Publishing production NAS stable.
- Installing/updating pilot workstations from the signed stable baseline.
- Enabling fail-closed enforcement.
- Running multi-machine migration rollout.

## Phase 1 - CD Design And Key Decisions

Goal: make the next deployment step explicit before touching production NAS.

Required outcomes:

- Decide the production release signing model:
  - private key storage location outside Git and outside NAS `tools`;
  - key backup and recovery owner;
  - key rotation policy and key ID naming;
  - public trusted release key deployment path for workstations.
- Decide the initial GitHub Actions deployment trigger:
  - protected manual workflow dispatch from `main`;
  - protected tag/release workflow;
  - or a two-step workflow where build/sign is automatic and NAS publish is an
    environment-approved job.
- Decide whether signing happens inside GitHub Actions or on a self-hosted
  runner. Prefer a self-hosted runner if the private signing key or NAS access
  should never leave the office-controlled environment.
- Record the chosen model in the developer runbook before enabling production
  publish automation.

Gate:

- No production publish until signing-key handling and approval path are
  documented.

## Phase 2 - GitHub Actions CD Producer

Goal: GitHub Actions can produce the same source-free signed release artifact
that the manual publish path produces today.

Required outcomes:

- Add a protected CD workflow that runs the existing non-Revit engineering
  gates before packaging.
- Build or validate the source-free user pack from a clean `main` checkout.
- Generate release manifest, channel manifest, detached signatures, package
  SHA256, and release sequence metadata.
- Run `scripts/check-signed-stable-readiness.ps1` against the produced release
  root before upload or NAS publish.
- Store the build output as workflow artifacts for review, but do not expose
  private signing material in logs or artifacts.

Gate:

- The workflow must fail if source files, source maps, `.pdb`, `.mdb`,
  developer manifests, private keys, or license secrets appear in the user
  package or release root.

## Phase 3 - CD To NAS Publish

Goal: GitHub Actions publishes the signed source-free release to the existing
NAS deployment layout without changing workstation updater behavior.

Required outcomes:

- Use a runner that can reach
  `\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy`.
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
- Keep publish approval human-controlled through a protected GitHub
  environment or an equivalent explicit operator gate.

Gate:

- Do not update `channels\stable.json` unless the signed-stable readiness
  preflight passes on the exact NAS release root that workstations will read.

## Phase 4 - Signed Stable Baseline

Goal: publish one signed production stable release while updater policy remains
compatible with unsigned legacy releases.

Required outcomes:

- Production public trusted release key material is installed on pilot
  workstations before the signed stable update is expected to verify.
- NAS stable points to a fully signed release with positive `releaseSequence`
  in both channel and manifest metadata.
- Updater reports distribution-integrity status as signed and verified on pilot
  machines.
- Unsigned legacy compatibility remains available only during the migration
  window.

Pilot machines:

- Net01 first.
- One or two additional workstations from different production contexts before
  broad rollout.

Gate:

- Do not enable fail-closed enforcement until pilot reports confirm signed
  verification and no source/developer artifacts after update.

## Phase 5 - Fail-Closed Enforcement

Goal: require valid signed channel and release manifests before workstation
package replacement.

Required outcomes:

- Updater policy is changed from compatibility to enforce only after signed
  stable baseline adoption is proven.
- Missing, partial, invalid, tampered, unknown-key, fingerprint-mismatched, or
  replayed older signed releases are blocked before package replacement.
- Emergency rollback remains explicit, local-operator controlled, and audited.
- Failure reports clearly distinguish distribution-integrity guards from
  generic install failures.

Gate:

- Enforcement must be a separate approved deployment step from the signed
  baseline publish.

## Phase 6 - Migration Rollout

Goal: move existing workstations from old source-carrying installs to the
source-free signed update path without damaging user Codex context.

Required outcomes:

- Run the migration tool in dry-run mode on each pilot class before commit.
- Confirm source/developer artifact inventory reaches zero after commit.
- Preserve user Codex sessions, memory, history, and active project context.
- Preserve previously disabled updater scheduled-task state unless an operator
  explicitly chooses to enable it.
- Keep local and remote reports for every migration run.

Gate:

- Broad rollout starts only after Net01 and at least one additional pilot pass
  migration, install/update, Codex config, and live Revit smoke checks.

## Phase 7 - Optional Entitlement And Obfuscation

Goal: evaluate additional copying-cost controls after the signed source-free
release channel is stable.

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
- Production publish remains human-approved.
- NAS publish and fail-closed policy changes remain separate actions.
- Source-free packaging, distribution integrity, migration, and optional
  entitlement are separate layers. Do not use one as a substitute for another.
