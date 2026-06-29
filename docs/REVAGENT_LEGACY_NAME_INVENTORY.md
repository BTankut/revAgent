# revAgent Legacy Name Inventory

Last updated: 2026-06-29

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

- a public runtime tool or environment variable that existing agents/scripts
  call, such as `get_revit_mcp_status` or `REVIT_MCP_*`;
- a repository, package, assembly, namespace, SDK, or project identity that has
  not yet gone through a dedicated migration PR;
- a legacy cleanup, compatibility, or fallback path that must still detect old
  installations;
- historical changelog text or retired/process documentation where changing the
  wording would make the historical record less accurate.

## Safe Cleanup Completed In This PR

- `config/rollout-readiness.sample.json` now points at the canonical
  `revAgent-deploy` release and reports roots.
- `config/rollout-readiness.sample.json` uses the current `452` stable package
  as sample live-smoke evidence.
- `SKILL.md` now uses
  `C:/ProgramData/DPE/revAgent/codex/working-context.md` as the primary working
  context path and mentions the old `RevitMCP` path only as pre-rename
  compatibility.

## Intentional Compatibility Names

These are expected to remain until a larger migration explicitly replaces them.

| Area | Examples | Reason |
| --- | --- | --- |
| Public runtime tool names | `get_revit_mcp_status` | Agents, docs, tests, and installed tool schemas already depend on the exact name. A rename needs aliasing and backward-compatibility tests. |
| Environment variables | `REVIT_MCP_PORT`, `REVIT_MCP_TARGET`, `REVIT_MCP_MAX_MESSAGE_BYTES` | Existing local launcher and runtime flows may set these variables. Rename only after adding `REVAGENT_*` aliases. |
| External SDK/package identity | `RevitMCPSDK`, `mcp-servers-for-revit` | These are upstream package and license identities, not product UI strings. |
| Revit source project and namespaces | `src/revit-plugin/revit-mcp-plugin`, `revit_mcp_plugin`, `RevitMCPCommandSet` | Installed artifact names are already revAgent-facing, but source project/namespace rename affects C# build, XAML class names, manifests, and payload freshness. |
| Installer helper modules | `installer/lib/RevitMcp.*.psm1`, `Read-RevitMcpJsonFile`, etc. | These are internal PowerShell module/function names used across installer tests and publish scripts. Rename as a focused script API migration. |
| Compatibility deployment root | `revit-mcp-deploy` | Dual-publish remains active until all office machines and desktop launchers are confirmed on `revAgent-deploy`. |
| Legacy cleanup paths | `C:\ProgramData\DPE\RevitMCP`, `mcp-servers-for-revit.addin`, `revit_mcp_plugin` | The updater must keep recognizing old installed surfaces so migration can remove them safely. |
| Historical records | older `CHANGELOG.md` entries and dated process docs | Preserve historical accuracy unless the text is active guidance. |

## Next Migration PRs

1. **Runtime alias PR**
   - Add `REVAGENT_*` environment variable aliases while preserving
     `REVIT_MCP_*`.
   - Keep `get_revit_mcp_status` as the public tool until a tool-alias strategy
     exists.
   - Add tests proving old and new variables resolve identically.

2. **Installer module rename PR**
   - Rename `installer/lib/RevitMcp.*.psm1` modules to `RevAgent.*.psm1`.
   - Add compatibility wrapper imports or update every caller in one PR.
   - Run full installer, signing, source-free, and publish tests.

3. **Revit source project rename PR**
   - Rename `src/revit-plugin/revit-mcp-plugin` and `RevitMCPCommandSet`
     source identities only after a clean Revit 2022 live smoke baseline.
   - Update C# namespaces, XAML `x:Class`, csproj assembly/root namespace,
     manifests, build scripts, payload freshness checks, and installed payload
     mapping together.
   - Require local non-Revit tests plus live Revit add-in load and command
     smoke.

4. **Repository rename PR**
   - Rename the local and GitHub repository only after the deployed NAS root is
     stable and compatibility root retirement criteria are met.
   - Update GitHub Actions, docs, clone instructions, and any hardcoded
     `BTankut/revit-mcp-skill` references.

5. **Compatibility root retirement**
   - Remove `revit-mcp-deploy` dual publish only after all active machines have
     reported canonical channel paths and no copied desktop launcher still
     depends on the legacy root.
   - Keep a rollback note and archival backup before deleting or freezing the
     old root.

## Do Not Bulk Rename

Do not run an unscoped repository-wide replacement of `RevitMCP` or
`revit-mcp`. The remaining names cross public tool contracts, environment
variables, C# namespaces, external SDK names, migration cleanup paths, and
historical docs. Each category needs its own compatibility plan and tests.
