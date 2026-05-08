# Monorepo Migration

## Decision

`BTankut/revit-mcp-skill` is the canonical production repository.

The Revit add-in source from `BTankut/revit-mcp-plugin` has been imported under
`src/revit-plugin`. The old plugin repository is no longer the development
source of truth.

## Why This Shape

Production machines consume one NAS package. Keeping the skill, runtime MCP
server, Revit add-in source, installer, deployment tools, and documentation in
one repository makes releases auditable and reduces the chance of shipping a
DLL built from a different source revision.

## Safe Transition Rules

- Work only on `main` unless a deliberate temporary branch is agreed first.
- Keep `kurulum` stable while production machines are updating from NAS.
- Build plugin source with `scripts/build-revit-plugin.ps1`.
- Commit source and generated installer payload together.
- Publish to NAS only after the repo is clean.
- Keep the old plugin repository private and archived after this monorepo is
  verified in production.

## What Was Not Moved Yet

The runtime MCP server and docs MCP server still live under `kurulum` because
the installer and NAS updater currently depend on that stable payload layout.
They can be moved to `src` in a later cleanup after one production cycle.

That later cleanup should be a separate release because it changes many paths.
