# revAgent Source Protection Plan

This plan tracks the phased move from developer-repo deployment to a
source-free user release pack. The deployed release artifact must contain only
the files required to run revAgent on a workstation.

## Phase 1 - Source-Free User Pack

Goal: release ZIPs and installed payloads stop carrying developer source code,
developer docs, tests, repo metadata, and debug artifacts.

Required outcomes:

- Publish uses an allowlist user-pack stage instead of copying the repo root.
- Installed Codex orchestration uses minimal user `SKILL.md` and `AGENTS.md`.
- Runtime MCP install contains build output and npm manifests, not TypeScript
  source or tests.
- Revit API docs MCP install contains build output, npm manifests, and the
  index builder required at runtime.
- Installer/updater clean old managed source leaks from `ProgramData` and the
  managed Codex skill integration without touching user Codex sessions,
  history, or memory.
- A gate fails the release when source paths or debug artifacts appear in the
  user pack.

## Phase 2 - JavaScript Payload Hardening

Goal: make runtime JavaScript less readable after the source-free package is
stable.

Required outcomes:

- Runtime MCP and Revit API docs MCP produce hardened release bundles from
  their TypeScript entrypoints.
- User packs copy each release bundle as the only file under the deployed
  `build/` directory.
- Release bundles are minified and do not include source maps.
- User-pack MCP `package.json` files are runtime-only and omit developer
  scripts, package `files` metadata, and `devDependencies`.
- User-pack MCP `package-lock.json` files omit dev dependency entries.
- Release gates fail if the user pack falls back to a multi-file developer
  build tree or carries an unhardened JavaScript package manifest.

## Phase 3 - .NET Payload Hardening

Goal: make Revit DLL inspection more expensive while preserving Revit loading
and live runtime behavior.

Required outcomes:

- Installer Revit payload roots must not contain `.pdb` or `.mdb` debug symbol
  files.
- Revit payload build refresh removes stale managed debug artifacts before
  writing the payload freshness manifest.
- CI fails if committed Revit installer payloads contain managed debug
  artifacts.
- Release publishing fails if the staged user pack contains managed debug
  artifacts anywhere in the ZIP payload.

Deferred gates:

- Obfuscation requires a Revit 2022 live model smoke test before it can be
  shipped.
- Signing requires a deployment trust decision and must not place private
  signing material in the client payload.

## Phase 4 - Know-How Boundary Review

Goal: decide which high-value heuristics should stay in local payloads and
which should move behind a controlled service boundary.

Required outcomes:

- Inventory runtime scoring, reconciliation, usage-intelligence, tool-routing,
  and mechanical decision logic.
- Record the decision classes in `docs/REVAGENT_KNOW_HOW_BOUNDARY_REVIEW.md`.
- Classify local-only, safe-to-ship, service-backed, hybrid-cache,
  reporting-boundary, and deferred candidates.
- Keep Codex workstation session, memory, and project context local.
- Keep live Revit model traversal, writes, image export, workbook ingestion,
  and raw telemetry out of service-backed product-logic flows unless a later,
  separately approved design changes the boundary.
- Require latency, offline fallback, data-minimization, versioning, and cache
  invalidation gates before any service-backed candidate is implemented.

## Phase 5 - Distribution Integrity

Goal: make release origin and package integrity verifiable.

Required outcomes:

- Record the trust model, signed-artifact shape, migration policy, key
  management rules, and license boundary in
  `docs/REVAGENT_DISTRIBUTION_INTEGRITY_PLAN.md`.
- Sign channel and release manifests with detached signatures before signature
  enforcement is enabled.
- Verify channel and release-manifest signatures in the updater before any
  local managed package folder is replaced.
- Keep private release-signing and licensing material outside Git, NAS
  `tools\`, user release ZIPs, updater payloads, runtime MCP payloads, and
  Revit DLL payloads.
- Keep license or seat checks separate from release signing. Client-side checks
  may carry only public verification material or service endpoints, never
  shared secrets or private signing keys.
- Ship distribution-integrity work as separate PRs: plan/gates, canonical JSON
  verifier fixtures, publish-path signing, updater compatibility verification,
  signed-stable baseline, enforcement flip, and optional license/seat work.
- Keep unsigned-release compatibility only for migration until a signed stable
  baseline has been published through the normal human-approved NAS flow.
