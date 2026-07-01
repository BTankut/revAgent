# revAgent Session Handoff - 2026-07-01

## Purpose

Use this file to continue the current revAgent rename/productization work after
the local workspace folder has been renamed from the old repository folder name
to `revAgent`.

The new session should read this file first, then read:

- `AGENTS.md`
- `docs/REVAGENT_LEGACY_NAME_INVENTORY.md`
- `docs/REVAGENT_REPOSITORY_RENAME_RUNBOOK.md`
- `docs/REVAGENT_ADDON_ARCHITECTURE_AND_RENAME_PLAN.md`

## Current Repository State

- Canonical GitHub repository: `BTankut/revAgent`
- Canonical remote URL: `https://github.com/BTankut/revAgent.git`
- Local workspace target path: `C:\Users\BT\Projects\revAgent`
- Active workspace path has been cut over to `C:\Users\BT\Projects\revAgent`.
- `main` was clean and synchronized after PR #191.
- No open PRs were present after PR #191 merged.
- No deploy was performed in this handoff sequence.

## Local Folder Cutover

The GitHub repository rename and local folder cutover are complete.

Verified from `C:\Users\BT\Projects\revAgent` on 2026-07-01:

```powershell
git remote -v
git fetch --prune
git status --short --branch
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-repo-rename-readiness.ps1
```

If another stale clone is still open at the old folder name, do not force-delete
or copy it. Close the locking process and use the repository rename runbook.

## Completed Workstream Summary

The broader source-free and revAgent default rollout is considered closed for
the current office rollout:

- Source-free standard user package is in place.
- Standard user packages no longer copy source/developer files to workstations.
- Production release identity defaults to `revAgent`.
- Canonical NAS deploy root is `revAgent-deploy`.
- Dashboard and usage-intelligence are admin add-ons, not part of the standard
  user package.
- Net01 live Revit/Codex tests passed on the revAgent default package.
- Office rollout was validated on representative machines; all machines do not
  need to be aligned before continuing product work.

## Latest Merged PRs

- #187 `Prepare repository rename to revAgent`
  - Active docs and GitHub examples were made ready for the repository rename.
  - Added `docs/REVAGENT_REPOSITORY_RENAME_RUNBOOK.md`.
  - Added repo rename readiness checks.

- #188 `Rename runtime package identity to revAgent`
  - Runtime npm package identity changed from `revit-mcp` to
    `revagent-runtime`.
  - Legacy `revit-mcp` bin alias remains for rolling-update compatibility.
  - Runtime status fallback package name now uses `revagent-runtime`.

- #189 `Align eval metadata with revAgent identity`
  - `evals/evals.json` now uses `skill_name: revAgent`.
  - Added `scripts/test-evals-branding.ps1`.

- #190 `Default machine reports to revAgent app identity`
  - Machine run reports, updater local state, dependency markers, and updater
    config default to `app: revAgent`.
  - Legacy `revit-mcp-skill` remains only as accepted release/recovery identity
    and cleanup marker.

- #191 `Record remote repository rename`
  - GitHub repository rename to `BTankut/revAgent` was recorded in docs.
  - Local folder rename was still pending at the time of that PR and has now
    been completed on the coordinator workstation.

## Validation Already Done

The following checks were run locally during the final PR sequence:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-repo-rename-readiness.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-evals-branding.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-mcp-build-payload-freshness.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ci.ps1
```

GitHub checks passed for the final PRs:

- Engineering gates passed.
- Claude review gate passed.
- GitGuardian passed.
- Main push CI passed.
- Signed Source-Free CD validation passed.
- NAS publish job was skipped; no deployment occurred.

## Process Rules To Keep

- Do not deploy unless the user explicitly requests it or a mandatory live test
  requires it.
- Continue with small PRs, Claude review gate, and merge when green.
- User has pre-approved merge for this uninterrupted rename/productization
  workstream.
- If live Revit, workstation, NAS, or manual validation becomes necessary, ask
  the user before continuing that part.
- Do not leave manual `@claude review` comments. Claude review runs through CI
  when the PR is marked ready.
- Open PRs as draft, push updates, mark ready, wait for Engineering gates and
  Claude review gate, fix real findings, then squash merge.
- Do not bulk-rename `RevitMCP`, `revit-mcp`, `revit_mcp`, or
  `mcp-servers-for-revit`.

## Important Boundaries

The following names are intentionally allowed for now:

- Public tool/API names such as `get_revit_mcp_status`.
- Legacy `REVIT_MCP_*` environment variable fallbacks.
- External SDK/package names such as `RevitMCPSDK` and
  `mcp-servers-for-revit`.
- Legacy cleanup paths such as `C:\ProgramData\DPE\RevitMCP`.
- Explicit release recovery identity `revit-mcp-skill`.
- Historical changelog/process records.
- Temporary rolling-update coordination names such as
  `revit-mcp-command-locks` and legacy registry fallback files.

These should only change through dedicated compatibility PRs with tests.

## Recommended Next Workstreams

1. **Deep legacy-name cleanup planning**
   - Use `docs/REVAGENT_LEGACY_NAME_INVENTORY.md` as the source of truth.
   - Pick small, testable categories.
   - Avoid native DLL/project/SDK changes unless a build and possible live
     Revit test are intentionally planned.

2. **Installer helper function canonicalization**
   - Many `installer/lib/RevAgent.*.psm1` files still define
     `RevitMcp*` functions and export `RevAgent*` aliases.
   - This is compatibility-safe but not fully canonical.
   - Rename one module at a time only when wrapper compatibility and smoke tests
     are updated.

3. **Native/internal Revit rename**
   - Native C# and SDK identifiers still include upstream or compatibility
     names.
   - This is a later, higher-risk workstream because it can require Revit add-in
     rebuilds, payload freshness updates, installer migration checks, and live
     Revit smoke testing.

## First Message For New Session

Suggested prompt for the new Codex session:

```text
Workspace is now C:\Users\BT\Projects\revAgent. First read AGENTS.md,
docs/SESSION_HANDOFF_2026-07-01.md,
docs/REVAGENT_LEGACY_NAME_INVENTORY.md, and
docs/REVAGENT_REPOSITORY_RENAME_RUNBOOK.md. Verify git remote/status, then
continue the revAgent rename/productization plan without deploying unless a
manual test or explicit deploy request requires it.
```
