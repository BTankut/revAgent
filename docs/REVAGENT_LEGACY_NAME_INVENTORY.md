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
- `config/rollout-readiness.sample.json` uses the current `460` stable package
  as sample live-smoke evidence.
- `config/rollout-readiness.sample.json` includes desktop launcher evidence so
  compatibility-root cleanup or freeze can be gated by data instead of a manual
  note.
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
- Revit add-in source projects now use `src/revit-plugin/revAgentPlugin`,
  `src/revit-plugin/revAgentCommandSet`, `RevAgentPlugin`, and
  `RevAgentCommandSet` identities. Installed add-in manifests point at
  `RevAgentPlugin.Core.Application`.
- Runtime default temp artifacts now use `revAgent-instances.json` and
  `revAgent-image-export`. The runtime still reads legacy
  `revit-mcp-instances.json` registry data during rolling updates.
- Production CD and STABLE launchers now publish/use only the canonical
  `revAgent-deploy` NAS root by default. The old `revit-mcp-deploy` root is no
  longer a default publish target or launcher fallback.
- Release consumers now accept both legacy `revit-mcp-skill` and new
  `revAgent` app identities in signed channel, signature-envelope, and release
  manifest validation. Producers have an explicit `ReleaseAppId` option, but
  still default to `revit-mcp-skill` until that compatibility build is deployed
  to the in-scope machines.

## Intentional Compatibility Names

These are expected to remain until a larger migration explicitly replaces them.

| Area | Examples | Reason |
| --- | --- | --- |
| Public runtime tool names | `get_revit_mcp_status` | Agents, docs, tests, and installed tool schemas already depend on the exact name. A rename needs aliasing and backward-compatibility tests. |
| Environment variables | preferred `REVAGENT_PORT`, `REVAGENT_TARGET`, `REVAGENT_MAX_MESSAGE_BYTES`; legacy fallback `REVIT_MCP_*` | New runtime/add-in reads prefer the revAgent names. Legacy aliases stay so older launchers and scripts do not break during rolling updates. |
| External SDK/package identity | `RevitMCPSDK`, `mcp-servers-for-revit` | These are upstream package and license identities, not product UI strings. |
| Release app and ZIP identity | current producer defaults to `revit-mcp-skill`; explicit producer option and consumers support `revAgent` | This must roll forward in two steps. First deploy consumers that accept both identities, then switch the default producer identity and ZIP naming in a later PR after workstation uptake is verified. |
| Installer helper API compatibility names | `Read-RevitMcpJsonFile`, `Get-RevitMcpUpdateDecision`, legacy `installer/lib/RevitMcp.*.psm1` wrappers | Canonical modules now export `RevAgent*` aliases for public helper functions. The original function definitions and wrapper files remain so older scripts and rollback paths keep working during rolling updates. |
| Retired compatibility deployment root | `revit-mcp-deploy` | Default dual-publish and launcher fallback have been removed after readiness evidence showed canonical `revAgent-deploy` channel paths and no copied legacy-root launchers for the in-scope machines. Keep the literal only for explicit diagnostics, migration recognition, historical docs, and any data-gated physical old-root cleanup/freeze. |
| Rolling-update runtime coordination | `revit-mcp-command-locks`, fallback `revit-mcp-instances.json` | The new runtime writes revAgent temp artifacts, but the command lock root and legacy registry fallback remain compatible while old and new workstation runtimes can coexist during rollout. |
| Legacy cleanup paths | `C:\ProgramData\DPE\RevitMCP`, `mcp-servers-for-revit.addin`, `revit_mcp_plugin` | The updater must keep recognizing old installed surfaces so migration can remove them safely. |
| Historical records | older `CHANGELOG.md` entries and dated process docs | Preserve historical accuracy unless the text is active guidance. |

## Next Migration PRs

1. **Repository rename PR**
   - Rename the local and GitHub repository only after the deployed NAS root is
     stable and compatibility root retirement criteria are met.
   - Update GitHub Actions, docs, clone instructions, and any hardcoded
     `BTankut/revit-mcp-skill` references.

2. **Compatibility root cleanup/freeze**
   - Default `revit-mcp-deploy` dual publish and launcher fallback are removed.
     Any physical old-root cleanup or freeze should still be preceded by
     `scripts\check-rollout-readiness.ps1` and desktop launcher evidence showing
     that all active machines use canonical channel paths and no copied launcher
     depends on the legacy root.
   - Produce launcher evidence with
     `scripts\publish-desktop-launcher-evidence.ps1`: `ScanLocal` writes
     per-machine evidence, and `Aggregate` writes the rollout evidence consumed
     by the readiness audit. After NAS publish, the helper is also available
     under `tools\publish-desktop-launcher-evidence.ps1`. The aggregate should
     cover every in-scope machine, and the audit can also combine latest
     per-machine evidence from `reports\machines\<machine>` when an aggregate is
     stale or partial.
   - Keep a rollback note and archival backup before deleting or freezing the
     old root.

3. **Release app identity producer switch**
   - After the compatibility updater is deployed to every in-scope machine,
     switch channel/signature/release-manifest producers from `revit-mcp-skill`
     to `revAgent`.
   - Rename package ZIP/cache/backup names only after updater acceptance and
     rollback behavior are covered by tests.

## Do Not Bulk Rename

Do not run an unscoped repository-wide replacement of `RevitMCP` or
`revit-mcp`. The remaining names cross public tool contracts, environment
variables, C# namespaces, external SDK names, migration cleanup paths, and
historical docs. Each category needs its own compatibility plan and tests.
