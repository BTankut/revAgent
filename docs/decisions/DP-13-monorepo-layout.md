# DP-13 — Monorepo Layout

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** M0 / build entry
**Recorded choice:** `packages/gateway`, `packages/bridge`, `packages/protocol`

## Decision

The migration uses the additive three-package workspace layout below.

## Guardrails

- Root npm workspaces include only `packages/*` packages that contain `package.json`.
- `packages/bridge` holds the .NET solution when DP-1 is confirmed and is not forced into npm.
- `installer/runtime-mcp-server` keeps its own lockfile and remains in place until the later relocation package.
- `src/revit-plugin`, `installer`, `addons`, `evals`, `config`, root `AGENTS.md`, and root `SKILL.md` remain untouched during W1-2.

## Why this default

It creates the target package boundaries without moving the frozen legacy runtime or add-in, preserving emergency NAS rebuildability and CI cache behavior.

## Change control

An alternative requires a dated R-F amendment and must preserve the frozen legacy paths, independent lockfile, and package ownership defined by the INDEX.
