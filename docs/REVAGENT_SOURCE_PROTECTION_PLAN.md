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

Candidate work:

- Bundle runtime MCP and docs MCP outputs into fewer files.
- Disable source maps in release artifacts.
- Minify and mangle release JavaScript.
- Remove test-only build outputs from the runtime package.

## Phase 3 - .NET Payload Hardening

Goal: make Revit DLL inspection more expensive while preserving Revit loading
and live runtime behavior.

Candidate work:

- Ensure release payloads never include `.pdb` files.
- Evaluate obfuscation on Revit 2022 payloads with a live model smoke test.
- Add signing if needed for deployment trust and integrity.

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
