# DP-13 — Monorepo Layout

**Status:** Awaiting operator confirmation
**Gate:** M0 / build entry
**Recommended default:** `packages/gateway`, `packages/bridge`, `packages/protocol`

## Decision

Confirm the additive workspace layout used for migration code.

## Guardrails

- Root npm workspaces include only `packages/*` packages that contain `package.json`.
- `packages/bridge` holds the .NET solution when DP-1 is confirmed and is not forced into npm.
- `installer/runtime-mcp-server` keeps its own lockfile and remains in place until the later relocation package.
- `src/revit-plugin`, `installer`, `addons`, `evals`, `config`, root `AGENTS.md`, and root `SKILL.md` remain untouched during W1-2.

## Why this default

It creates the target package boundaries without moving the frozen legacy runtime or add-in, preserving emergency NAS rebuildability and CI cache behavior.

## Confirmation prompt

Approve the three-package layout, or record an alternative that preserves the frozen legacy paths, independent lockfile, and package ownership defined by the INDEX.
