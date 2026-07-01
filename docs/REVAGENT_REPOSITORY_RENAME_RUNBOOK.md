# revAgent Repository Rename Runbook

## Purpose

This runbook covers the coordinated local and GitHub repository rename from the
old development repository name to the canonical revAgent repository name.

Target GitHub repository:

```text
BTankut/revAgent
```

Target local development path on the coordinator workstation:

```text
C:\Users\BT\Projects\revAgent
```

## Current Status

- GitHub repository rename is complete: canonical remote is now
  `BTankut/revAgent`.
- Local coordinator workspace rename is complete: the active workspace is
  `C:\Users\BT\Projects\revAgent`.
- Post-rename verification passed on 2026-07-01: canonical remote URL,
  `gh repo view`, `git status --short --branch`, and
  `scripts\test-repo-rename-readiness.ps1`.

## Preflight

1. Confirm `main` is clean and pushed.
2. Confirm there is no open PR that must merge before the rename.
3. Confirm the current NAS stable is already using the canonical revAgent
   deploy root and `app: revAgent`.
4. Confirm GitHub Actions are not running a production publish.
5. For any stale local clone still using the old folder name, close tools that
   hold that clone before attempting a local rename.

## GitHub Repository Rename

Status: completed on 2026-07-01.

From the current repository folder:

```powershell
$repo = gh repo view --json nameWithOwner --jq .nameWithOwner
gh api -X PATCH "repos/$repo" -f name=revAgent
gh repo view BTankut/revAgent --json nameWithOwner,url
```

GitHub normally keeps redirects for the old clone URL, but do not rely on that
as the canonical state. Treat redirects only as a temporary transition aid.

## Local Rename

Status: completed on 2026-07-01 for the coordinator workspace.

For a stale secondary clone that still uses the old folder name, close tools
that hold the repository folder, then run from the parent folder:

```powershell
Set-Location C:\Users\BT\Projects
Rename-Item -LiteralPath .\revit-mcp-skill -NewName revAgent
Set-Location .\revAgent
git remote set-url origin https://github.com/BTankut/revAgent.git
git remote -v
git fetch --prune
git status --short --branch
```

If the folder is locked by an active editor or terminal, do not force-delete or
copy the repository. Close the locking process and retry the rename.

## Post-Rename Verification

Run these from the renamed folder:

```powershell
git status --short --branch
gh repo view --json nameWithOwner,url
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-repo-rename-readiness.ps1
```

The normal PR loop should still work because GitHub Actions and runbook
examples resolve the active repository through GitHub context or `gh repo view`
instead of hardcoding the old slug.

## Boundaries

This rename does not change public runtime tool names, legacy environment
variable fallbacks, release recovery app ids, old backup/cache cleanup filters,
or historical changelog text. Those remain governed by
`docs/REVAGENT_LEGACY_NAME_INVENTORY.md`.
