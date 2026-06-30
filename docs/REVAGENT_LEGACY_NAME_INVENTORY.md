# revAgent Legacy Name Inventory

Last updated: 2026-06-30

This document tracks remaining `RevitMCP`, `revit-mcp`, `revit_mcp`, and
`mcp-servers-for-revit` names after the front-layer revAgent rename and the
canonical NAS root migration. The goal is to avoid broad search-and-replace
changes that would break installed clients, build contracts, Revit add-in
identity, or compatibility cleanup.

## Current Rule

Use `revAgent` for product-facing text, installed user surfaces, admin add-ons,
dashboard, usage intelligence, Codex MCP registration, Revit ribbon UI, and NAS
canonical deployment paths.

Keep legacy names only when they are one of these exact identities:

- a public runtime tool or legacy environment variable that existing
  agents/scripts call, such as `get_revit_mcp_status` or fallback
  `REVIT_MCP_*`;
- a repository, package, assembly, namespace, SDK, or project identity that has
  not yet gone through a dedicated migration PR;
- a legacy cleanup, compatibility, or fallback path that must still detect old
  installations;
- historical changelog text or retired/process documentation where changing the
  wording would make the historical record less accurate.

## Safe Cleanup Completed So Far

- `config/rollout-readiness.sample.json` now points at the canonical
  `revAgent-deploy` release and reports roots.
- `config/rollout-readiness.sample.json` uses the current `452` stable package
  as sample live-smoke evidence.
- `SKILL.md` now uses
  `C:/ProgramData/DPE/revAgent/codex/working-context.md` as the primary working
  context path and mentions the old `RevitMCP` path only as pre-rename
  compatibility.
- Runtime connection, framing, add-in port/autostart, message-size, and
  installed-state overrides now prefer `REVAGENT_*` environment variables and
  preserve `REVIT_MCP_*` as legacy fallback aliases.
- Installer helper module files now use canonical `installer/lib/RevAgent.*.psm1`
  names. Matching `installer/lib/RevitMcp.*.psm1` files remain only as
  compatibility wrappers that import the new modules.
- Exported installer helper functions now expose `RevAgent*` aliases while
  retaining the original `RevitMcp*` function definitions for rolling-update
  compatibility.
- Installer entrypoint private helper names now use `RevAgent*` names in the
  workstation installer, updater, migration, publisher, readiness, and signed-CD
  scripts. Legacy cleanup/path literals and public compatibility APIs remain
  unchanged.

## Intentional Compatibility Names

These are expected to remain until a larger migration explicitly replaces them.

| Area | Examples | Reason |
| --- | --- | --- |
| Public runtime tool names | `get_revit_mcp_status` | Agents, docs, tests, and installed tool schemas already depend on the exact name. A rename needs aliasing and backward-compatibility tests. |
| Environment variables | preferred `REVAGENT_PORT`, `REVAGENT_TARGET`, `REVAGENT_MAX_MESSAGE_BYTES`; legacy fallback `REVIT_MCP_*` | New runtime/add-in reads prefer the revAgent names. Legacy aliases stay so older launchers and scripts do not break during rolling updates. |
| External SDK/package identity | `RevitMCPSDK`, `mcp-servers-for-revit` | These are upstream package and license identities, not product UI strings. |
| Revit source project and namespaces | `src/revit-plugin/revit-mcp-plugin`, `revit_mcp_plugin`, `RevitMCPCommandSet` | Installed artifact names are already revAgent-facing, but source project/namespace rename affects C# build, XAML class names, manifests, and payload freshness. |
| Installer helper API compatibility names | `Read-RevitMcpJsonFile`, `Get-RevitMcpUpdateDecision`, legacy `installer/lib/RevitMcp.*.psm1` wrappers | Canonical modules now export `RevAgent*` aliases for public helper functions. The original function definitions and wrapper files remain so older scripts and rollback paths keep working during rolling updates. |
| Compatibility deployment root | `revit-mcp-deploy` | Dual-publish remains active until the rollout readiness audit reports canonical `revAgent-deploy` channel evidence for every in-scope machine and copied desktop launchers are confirmed off the legacy root. |
| Legacy cleanup paths | `C:\ProgramData\DPE\RevitMCP`, `mcp-servers-for-revit.addin`, `revit_mcp_plugin` | The updater must keep recognizing old installed surfaces so migration can remove them safely. |
| Historical records | older `CHANGELOG.md` entries and dated process docs | Preserve historical accuracy unless the text is active guidance. |

## Next Migration PRs

1. **Revit source project rename PR**
   - Rename `src/revit-plugin/revit-mcp-plugin` and `RevitMCPCommandSet`
     source identities only after a clean Revit 2022 live smoke baseline.
   - Update C# namespaces, XAML `x:Class`, csproj assembly/root namespace,
     manifests, build scripts, payload freshness checks, and installed payload
     mapping together.
   - Require local non-Revit tests plus live Revit add-in load and command
     smoke.

2. **Repository rename PR**
   - Rename the local and GitHub repository only after the deployed NAS root is
     stable and compatibility root retirement criteria are met.
   - Update GitHub Actions, docs, clone instructions, and any hardcoded
     `BTankut/revit-mcp-skill` references.

3. **Compatibility root retirement**
   - Remove `revit-mcp-deploy` dual publish only after all active machines have
     reported canonical channel paths through
     `scripts\check-rollout-readiness.ps1` and no copied desktop launcher still
     depends on the legacy root.
   - Keep a rollback note and archival backup before deleting or freezing the
     old root.

## Do Not Bulk Rename

Do not run an unscoped repository-wide replacement of `RevitMCP` or
`revit-mcp`. The remaining names cross public tool contracts, environment
variables, C# namespaces, external SDK names, migration cleanup paths, and
historical docs. Each category needs its own compatibility plan and tests.
