# revAgent Add-on Architecture And Rename Plan

## Decision

Dashboard and usage-intelligence are revAgent product functions, but they are
not part of the standard user install. They must be split from the core
workstation package and installed only on an admin/coordinator machine through
explicit add-ons.

This replaces the attempted PR #130 direction. A locked legacy dashboard tunnel
must not be treated as a harmless cleanup warning. The correct fix is to give
dashboard and usage-intelligence first-class revAgent ownership, package them as
admin add-ons, migrate their runtime state to the revAgent path, and only then
clean legacy RevitMCP paths.

## Product Package Model

### Core Standard User Package

Installed on ordinary production user machines.

Contains:

- Revit add-in payload.
- revAgent runtime MCP server.
- Revit API docs MCP server.
- Codex user instructions and MCP registration.
- updater, migration, source-free cleanup, reporting, and license/signature
  verification.

Does not contain:

- dashboard UI/server payload.
- Cloudflare tunnel files or credentials.
- usage-intelligence summary publisher.
- admin/coordinator scheduled tasks.

Naming note: the public product role should move from "workstation package" to
"standard user package" or "user package". "Workstation" can remain only where
it is technically useful for machine-level implementation details.

### Dashboard Add-on

Installed only on the admin/coordinator machine.

Owns:

- local read-only dashboard server.
- dashboard static UI.
- dashboard task/launcher.
- Cloudflare tunnel for `dashboard.revagent.app`.
- Cloudflare tunnel config, logs, and runtime binary ownership under the
  revAgent path.

Target install root:

```text
C:\ProgramData\DPE\revAgent\addons\dashboard
```

Scheduled tasks:

- `revAgent Dashboard Server`
- `revAgent Dashboard Tunnel`

### Usage-Intelligence Add-on

Installed only on the admin/coordinator machine.

Owns:

- daily usage summary publisher.
- usage summary task/launcher/config.
- summary output policy and analyst input files.

Target install root:

```text
C:\ProgramData\DPE\revAgent\addons\usage-intelligence
```

Scheduled task:

- `revAgent Usage Summary Publish`

## Repository Layout Target

Add-ons should live as first-class product modules:

```text
addons/
  dashboard/
    addon.json
    installer/
    server/
    public/
    tunnel/
    tests/
  usage-intelligence/
    addon.json
    installer/
    scripts/
    tests/
```

The repository dashboard and usage-intelligence payloads now move into these
add-on folders. Root usage scripts remain only as compatibility wrappers for
local developer workflows. Shared helpers should either remain in
`installer/lib` when they are truly core installer infrastructure, or move into
an add-on-local helper folder when they are admin-only.

Add-on manifests should declare at minimum:

- add-on id.
- product display name.
- install role: `admin`.
- install root.
- scheduled tasks owned by the add-on.
- files copied into the admin install.
- migration sources from legacy paths.
- uninstall/cleanup policy.

## NAS Release Model

The standard signed source-free release ZIP remains the core user package.

Admin add-ons should not be copied into the core user ZIP. They should be
published under a separate NAS add-on surface:

```text
\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\addons\
  dashboard\
  usage-intelligence\
```

Initial implementation can publish add-ons as NAS tools payloads. The later
commercial-grade implementation should sign/version add-ons separately:

```text
releases\
  <core-version>\
addons\
  dashboard\
    <addon-version>\
  usage-intelligence\
    <addon-version>\
channels\
  stable.json
  addons\
    dashboard-stable.json
    usage-intelligence-stable.json
```

## Current Machine Migration Rule

Current observed state on the developer/admin machine:

- `cloudflared.exe` is active from
  `C:\ProgramData\DPE\RevitMCP\cloudflared`.
- Its config maps `dashboard.revagent.app` to `http://127.0.0.1:8765`.
- The local dashboard server is active and serves `revAgent Dashboard`.
- The dashboard server currently runs from the repo path, not from a product
  install path.

Correct migration:

1. Install dashboard add-on under
   `C:\ProgramData\DPE\revAgent\addons\dashboard`.
2. Copy or resolve `cloudflared.exe` into the dashboard add-on path.
3. Copy legacy tunnel config and credential references without printing secrets.
4. Rewrite path-owned fields such as `logfile` to the revAgent add-on path.
5. Start the dashboard server from the add-on payload.
6. Start the Cloudflare tunnel from the add-on path.
7. Verify local dashboard health and tunnel registration.
8. Stop the legacy `RevitMCP\cloudflared` process.
9. Remove old legacy tunnel files only after the new add-on tunnel is healthy.
10. Run normal legacy RevitMCP cleanup after dashboard ownership no longer
    depends on the legacy root.

Rollback rule: if the new dashboard server or tunnel does not become healthy,
leave the old process/path running and report the migration as blocked. Do not
delete legacy files in that case.

## Rename Roadmap

The long-term target is to remove old `revit-mcp-skill`, `RevitMCP`, and
Revit MCP product wording from product-facing surfaces and deployment paths.

### Canonical Names

Target local repository path:

```text
C:\Users\BT\Projects\revAgent
```

Target GitHub repository:

```text
BTankut/revAgent
```

Target NAS deploy root:

```text
\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy
```

The existing NAS root
`\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy` must remain as a temporary
compatibility surface during migration because installed updaters currently
read its `channels\stable.json`.

### NAS Rename Strategy

1. Add a canonical release-root setting for `revAgent-deploy`.
2. Publish the same signed stable release to both old and new NAS roots for a
   short compatibility window.
3. Update installer/updater config during a normal successful update so local
   machines point to the new `revAgent-deploy` channel path.
4. Confirm dashboard reports and machine status use the new root.
5. Freeze the old `revit-mcp-deploy` root as compatibility-only.
6. Remove old-root dependency only after all active machines have migrated.

### Repo Rename Strategy

1. Finish and merge add-on split first.
2. Ensure CI/CD, publish scripts, runbooks, and local tools use repo-root
   discovery rather than hardcoded `revit-mcp-skill`.
3. Rename local folder from `revit-mcp-skill` to `revAgent`.
4. Rename GitHub repository to `revAgent`.
5. Update local remote URL and any docs/scripts that reference the old repo
   name.
6. Keep GitHub redirect compatibility only as a short transition aid.

### Internal Code Rename Strategy

Internal implementation names such as `RevitMCPCommandSet`, source folder
names, class names, and compatibility module names should be cleaned in later
small PRs. Do not bundle these deep renames into the add-on split unless a file
is already being moved for the add-on architecture.

## Proposed PR Sequence

1. **Plan and cleanup**
   - Close PR #130 as superseded.
   - Add this plan.
   - No deploy.

2. **Add-on scaffold**
    - Create `addons/dashboard` and `addons/usage-intelligence`.
    - Move existing dashboard and usage-intelligence files into add-on folders.
    - Add `addon.json` manifests.
    - Update tests to assert admin add-ons are excluded from the core user ZIP.
    - Keep root usage scripts as compatibility wrappers that delegate into the
      add-on scripts.

3. **Dashboard add-on installer**
   - Install dashboard server and static UI under
     `C:\ProgramData\DPE\revAgent\addons\dashboard`.
   - Own `revAgent Dashboard Server` scheduled task.
   - Add local health checks.
   - Keep Cloudflare tunnel migration out of this PR unless the new tunnel is
     independently verified healthy.

4. **Dashboard tunnel migration**
   - Migrate Cloudflare tunnel from legacy `RevitMCP\cloudflared` to the
     dashboard add-on path.
   - Verify new tunnel before stopping old tunnel.
   - Clean legacy tunnel only after successful migration.
   - Implementation note: the add-on now exposes
     `installer\install-dashboard-tunnel.ps1` and root wrapper
     `scripts\install-dashboard-tunnel.ps1`. Live admin execution still needs a
     coordinator-machine run with health checks before old tunnel cleanup.

5. **Usage-intelligence add-on installer**
   - Install summary publisher under
     `C:\ProgramData\DPE\revAgent\addons\usage-intelligence`.
   - Own `revAgent Usage Summary Publish` scheduled task.
   - Remove repo-path assumptions from usage summary task setup.

6. **Admin tools publish**
   - Publish admin add-on installers and payload under NAS
     `tools\addons`.
   - Keep core signed release ZIP source-free and admin-free.
   - Add admin install runbook.

7. **Pilot admin migration**
   - Run on the current admin/developer machine.
   - Confirm:
     - dashboard still opens locally.
     - `dashboard.revagent.app` still routes correctly.
     - tunnel process now runs from `C:\ProgramData\DPE\revAgent\addons`.
     - usage summary task runs from revAgent add-on path.
     - old `C:\ProgramData\DPE\RevitMCP` can be cleaned safely.

8. **NAS root rename**
   - Introduce `revAgent-deploy` as canonical.
   - Dual-publish old and new roots during transition.
   - Update local updater configs to the new root.
   - Retire old NAS root after machine migration.

9. **Repo rename**
   - Rename local and GitHub repo to `revAgent`.
   - Update docs, CI/CD, and tool references.
   - Keep old remote redirect only during transition.

10. **Deep internal rename**
    - Remove remaining internal `RevitMCP` and `revit-mcp` names in small,
      testable PRs.
    - Preserve compatibility aliases only where old installed clients still
      need them.

## Acceptance Criteria

- Standard user install/update does not install dashboard, Cloudflare tunnel,
  or usage-intelligence admin scheduled tasks.
- Admin/coordinator install can install dashboard and usage-intelligence
  without requiring the source repo path.
- Dashboard and tunnel run from `C:\ProgramData\DPE\revAgent\addons`.
- Legacy `C:\ProgramData\DPE\RevitMCP` cleanup is blocked until dashboard
  ownership has migrated away from it.
- NAS deploy root and repo names have a documented transition path from old
  `revit-mcp-*` names to revAgent names.
- Product-facing docs and UI use revAgent terminology.
