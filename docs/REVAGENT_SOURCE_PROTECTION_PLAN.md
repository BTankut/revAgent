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

Candidate work:

- Inventory runtime scoring, reconciliation, usage-intelligence, tool-routing,
  and mechanical decision logic.
- Classify local-only, safe-to-ship, and service-backed candidates.
- Keep Codex workstation context local while moving only reusable protected
  product logic when it is worth the operational cost.

## Phase 5 - Distribution Integrity

Goal: make release origin and package integrity verifiable.

Candidate work:

- Sign release manifests.
- Verify signatures in the updater before install.
- Add license or seat checks without putting private signing/licensing secrets
  in the client payload.
