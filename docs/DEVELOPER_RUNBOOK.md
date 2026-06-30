# Developer Runbook

This file is for developers and code assistants. It is not an end-user
installation guide. Its purpose is to preserve the operational context needed
to continue development, release, and office deployment from any workstation
that can clone this repository and reach the NAS share.

## Canonical Sources

- Product name: `revAgent`
- GitHub repository: `BTankut/revit-mcp-skill`
- Local development path on the current workstation:
  `C:\Projects\revit-mcp-skill`
- Main branch: `main`
- Office deployment source:
  `\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy`
- Standard workstation install root:
  `C:\ProgramData\DPE\revAgent`

GitHub is the source history. The NAS share is the deployment source read by
office workstations. A normal feature-branch `git commit` or `git push` does
not deploy anything by itself. A protected `main` update starts signed
source-free CD build/validation, but production NAS stable publish requires a
manual `workflow_dispatch` run with `publish_to_nas=true`.

Development and production releases are managed from `main`. Historical
branches or older repositories are not part of the current production flow.
Use `revAgent` for product-facing text and UI-facing documentation. Keep
`revit-mcp`, `RevitMCP*`, `mcp-servers-for-revit`, and
`C:\ProgramData\DPE\revAgent` only when an exact repo, MCP server, skill,
assembly, manifest, task, package, or path identity is required.

## First Files To Read After Cloning

When this repo is cloned on another development workstation, read these files
before making changes:

1. `README.md`
2. `docs/DEVELOPER_RUNBOOK.md`
3. `docs/REPOSITORY_STRUCTURE.md`
4. `docs/PLATFORM_ARCHITECTURE.md`
5. `installer/nas/README.md`
6. `CHANGELOG.md`
7. `AGENTS.md`
8. `SKILL.md`
9. `docs/REVAGENT_LEGACY_NAME_INVENTORY.md` when touching rename,
   compatibility, install path, or package identity work

If Revit automation will be tested live, also read the installed or repo copy of
`SKILL.md` and follow the revAgent status preflight rule before every
non-status runtime command.

## Repository Map

High-value paths:

```text
revit-mcp-skill/
|-- README.md
|-- SKILL.md
|-- AGENTS.md
|-- CHANGELOG.md
|-- config/
|   |-- dynamic-tool-promotion-registry.json
|   |-- dynamic-tool-promotion-rules.json
|   `-- revit-versions.json
|-- docs/
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- DEVELOPER_RUNBOOK.md
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- REPOSITORY_STRUCTURE.md
|   |-- REVAGENT_DISTRIBUTION_INTEGRITY_PLAN.md
|   |-- REVAGENT_KNOW_HOW_BOUNDARY_REVIEW.md
|   |-- REVAGENT_SIGNED_SOURCE_FREE_CD_ROLLOUT_PLAN.md
|   |-- REVAGENT_USAGE_INTELLIGENCE.md
|   `-- REVIT_IMAGE_EXPORT.md
|-- references/
|-- addons/
|   |-- dashboard/
|   `-- usage-intelligence/
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- check-rollout-readiness.ps1
|   |-- start-live-dashboard.ps1
|   |-- test-all.ps1
|   |-- test-commandset-live.ps1
|   |-- test-live-dashboard.ps1
|   |-- test-mcp-build-payload-freshness.ps1
|   |-- test-typescript-nocheck-policy.ps1
|   |-- test-distribution-integrity.ps1
|   `-- test-installer-smoke.ps1
|-- src/
|   `-- revit-plugin/
`-- installer/
    |-- install-self-contained.ps1
    |-- lib/
    |-- nas/
    |-- runtime-mcp-server/
    |-- revit-api-docs-mcp/
    |-- command-payload/
    `-- revit-plugin/
```

Important source vs payload rule:

- `src/revit-plugin/` is the Revit add-in source.
- `installer/revit-plugin/` is the bundled install payload.
- `installer/command-payload/` is the bundled shared bridge command payload.
- `installer/runtime-mcp-server/src/` is the runtime MCP TypeScript source;
  `installer/runtime-mcp-server/build/` is the developer/test build payload and
  `installer/runtime-mcp-server/release/` is the hardened release bundle used
  by user packs.
- `installer/revit-api-docs-mcp/src/` is the docs MCP TypeScript source;
  `installer/revit-api-docs-mcp/build/` is the developer/test build payload and
  `installer/revit-api-docs-mcp/release/` is the hardened release bundle used
  by user packs.
- `installer/codex-user/` contains the minimal installed Codex orchestration
  files used by the user pack.
- `installer/lib/` contains shared PowerShell helper modules used by installer
  and updater entrypoints.
- `config/revit-versions.json` is the central Revit version matrix.
- `config/dynamic-tool-promotion-*.json` defines the usage-summary rules for
  flagging repeated or risky dynamic C# snippets as native runtime-tool
  candidates.

Do not edit deployed files under `C:\ProgramData\DPE\revAgent` as a source of
truth. Fix the repo, rebuild or refresh payloads when needed, commit the repo,
then install or publish through the normal flow.

## Development Setup On A New Machine

Clone the repo:

```powershell
git clone https://github.com/BTankut/revit-mcp-skill.git C:\Projects\revit-mcp-skill
cd C:\Projects\revit-mcp-skill
git status
git branch --show-current
```

Expected branch: `main`.

Required local tools for full development:

- Git for Windows
- Autodesk Revit 2022
- Node.js 20 or newer
- Codex Desktop app or another MCP/skill-capable host
- PowerShell 5.1 or newer
- Visual Studio/MSBuild tooling if rebuilding the Revit add-in source
- Access to `\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy` for office
  publishing and workstation updater tests. During the NAS root transition,
  access to the legacy `revit-mcp-deploy` root is also needed for compatibility
  publish verification.

Office workstations reach the internet through `http://192.168.90.10:6588`.
The NAS installer/updater configures this proxy automatically for terminal
environment variables, WinHTTP, current-user Windows internet settings, npm,
and Git. Keep this behavior in sync if the office proxy changes.

Before changing anything on a new machine:

```powershell
git pull --ff-only
git status --short
```

The publish script refuses dirty releases unless `-AllowDirty` is explicitly
used. Production NAS releases should be published from a clean tree.

## Normal Development Workflow

1. Pull latest `main`.
2. Create a topic branch such as `codex/<short-topic>`.
3. Inspect existing patterns before editing.
4. Make the smallest safe change in source files.
5. If Revit add-in source, DLL, or command payload changed, rebuild the plugin
   payload so the committed DLLs and Revit payload manifest move together.
6. Run targeted validation. For Revit C#/DLL/command-payload changes, a green
   `Engineering gates` CI result is not enough; before deployment, also run
   the local live gate (`scripts/test-commandset-live.ps1`). CI covers the
   manifest-based Revit payload freshness check, but not live Revit behavior.
7. Commit source and generated payload together when payload is affected.
8. Push the topic branch and open a pull request. See `Git Commit And Push` for
   the exact protected branch workflow.
9. Merge only after `Engineering gates` and GitGuardian are green, the
   `Claude review gate` has run, and actionable review comments are addressed. Do
   not leave manual `@claude`, `@codex`, or `@gemini` review-trigger comments;
   review runs from GitHub Actions. For the fast autonomous
   draft->ready->auto-merge variant, see "Nightly autonomous PR loop" below.
10. Update local `main` with `git pull --ff-only`.
11. Watch the signed source-free CD run that starts from the protected `main`
    update.
12. Verify NAS `stable.json`, release manifest, ZIP path/hash, and at least one
    real Revit workstation before broad or manual rollout. If scheduled auto
    update remains enabled, workstations may consume the new stable channel at
    the next 12:00 check even without a manual rollout instruction.

Useful baseline commands:

```powershell
cd C:\Projects\revit-mcp-skill
git status --short
git pull --ff-only
```

## Nightly autonomous PR loop

This is the fast, fully-autonomous variant of the workflow above: the same quality
gates, but each gate runs once at the right moment so a clean change reaches
`main` in ~4 minutes with no human merge click.

> Prerequisite (one-time repo settings): repository auto-merge enabled and the
> `Claude review gate` check added to `main` branch protection's required checks.
> Until those are set, follow steps 1-5 but merge manually once both checks pass.

1. Branch, then open the PR as a DRAFT: `gh pr create --draft --fill`
2. Iterate freely. Each push runs only `Engineering gates` (~2 min) - fast
   feedback. No Claude review runs while the PR is a draft.
3. When the work is complete and `Engineering gates` is green:
   - `gh pr ready <num>`            # triggers exactly one Claude review
   - `gh pr merge <num> --auto --squash`
4. Review effort is automatic: `high` by default, `xhigh` when the diff touches
   risk paths (`src/revit-plugin/**`, `installer/**`, signing/publish/NAS scripts,
   `signed-source-free-cd.yml`).
5. If the `Claude review gate` check is RED (blocking issue): push a fix, then
   re-request one review by toggling ready state:
   `gh pr ready <num> --undo && gh pr ready <num>`
6. Auto-merge completes once `Engineering gates` + `Claude review gate` are both
   green and the branch is up to date with `main`. No human click required; read
   the review comments in the morning.

Notes:
- The review fires on `ready_for_review` (and `opened`/`reopened`), never on
  follow-up pushes - that is why a draft never burns a review and a fix needs the
  ready toggle in step 5.
- The chosen effort tier is logged in the review run's "Determine review effort
  tier" step (Actions tab) - check it there if you are unsure whether a diff was
  treated as a risk path. It logs e.g. `Review effort tier: high (changed files: 3)`.
- The gate is fail closed: if the review errors or returns no structured verdict
  the check is RED, the PR will not auto-merge, and the workflow posts a
  technical failure comment so the operator does not have to discover the cause
  only from the Actions tab.
- A PR that edits `.github/workflows/claude-review.yml` cannot self-review
  (`claude-code-action` skips when the workflow differs from the default branch),
  so its `Claude review gate` will be RED; merge such a PR by hand after human
  review and confirm the change on the next normal PR.
- Because `strict` (up-to-date) is on, if `main` advances while an auto-merge is
  armed, GitHub updates the branch to a new head commit. The review does NOT
  re-fire on that branch update (only `Engineering gates` re-runs), so the new
  head has no `Claude review gate` status and auto-merge stalls until you
  re-request a review: `gh pr ready <num> --undo && gh pr ready <num>`. In
  one-PR-at-a-time work this never triggers; it only matters when several PRs
  land overnight. It fails safe (the PR waits; it never merges unreviewed).

## Production Rollout Hold

The stable channel is consumed by the daily workstation updater. "Verify before
rollout" only gates manual operator instructions unless scheduled update checks
are held first.

If a release must not reach workstations until after manual verification, do one
of these before updating protected `main` or publishing stable:

- keep the change on a topic branch or a non-stable test channel
- disable the workstation scheduled task on the affected machines

```powershell
Disable-ScheduledTask -TaskName "revAgent Auto Update"
Enable-ScheduledTask -TaskName "revAgent Auto Update"
```

Use the legacy task name `Revit MCP Auto Update` only when maintaining an older
pre-rename workstation. Re-enable the scheduled task only after the signed CD
run, `channels\stable.json`, release manifest, package hash, and pilot
workstation check are accepted.

## Revit Add-In Development

Edit source under:

```text
src\revit-plugin\
```

Then rebuild and refresh the installer payload:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Commit together:

- changed files under `src/revit-plugin/`
- refreshed files under `installer/revit-plugin/`
- refreshed files under `installer/command-payload/` if the command payload
  changed
- `installer/revit-payload-manifest.json`
- `CHANGELOG.md` when behavior changes
- relevant docs

Do not publish an add-in change if the payload binaries were not refreshed.
The refresh step removes managed debug symbol files from the installer payload;
committed Revit payloads and release ZIPs must not contain `.pdb` or `.mdb`
files.
For Revit C#/DLL/command-payload changes, the CI `Engineering gates` check
proves the committed manifest and payload files match source, but it is not
sufficient for deployment readiness. Run the local live commandset gate before
NAS publish.

## Runtime And Docs MCP Development

The office package includes two local MCP servers:

- `revit-mcp`: live Revit runtime execution and inspection
- `revit-api-docs`: local Revit API DLL/XML lookup

Installed workstation registrations normally point to:

```text
C:\ProgramData\DPE\revAgent\runtime\build\index.js
C:\ProgramData\DPE\revAgent\package\installer\revit-api-docs-mcp\build\index.js
```

Both servers are required. If only the runtime server is available, non-trivial
Revit API work is not considered fully set up.

Both MCP packages are TypeScript-first. Edit `src/`, then emit the existing
`build/` contract. Both package `tsconfig.json` files must keep `strict: true`
without masking it with `noImplicitAny:false` or
`useUnknownInCatchVariables:false`. New source must not add `@ts-nocheck`; the
current policy allowlist is empty and the runtime/docs MCP source trees are
expected to stay checked by default.

```powershell
cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

`npm run test` runs `tsc` and a local smoke check. It does not need Revit. The
docs MCP smoke intentionally verifies tool registration without requiring a
local Revit API index.

After changes to bundled MCP server payloads, run the relevant local tests,
run `npm run build:release`, commit `src/`, `build/`, `release/`,
`package.json`, and `package-lock.json` together, and verify `codex mcp list`
after install or update.

For runtime/docs MCP source changes, also keep the committed payload fresh:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-typescript-nocheck-policy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-mcp-build-payload-freshness.ps1
```

## PowerShell Installer/Updater Modules

Public entrypoint script names stay stable, but shared behavior lives under
`installer/lib/`:

- hidden VBS launcher generation
- scheduled task action creation/repair
- targeted permission repair
- package path/layout and ZIP extraction
- Revit version matrix and install-root discovery
- Revit-open defer/update policy
- proxy normalization
- Codex MCP `config.toml` registration helper
- JSON reporting helper

When updater tools are installed or published to NAS, the `lib` folder must be
copied beside them. The matching `config` folder must also be copied so the
Revit version matrix is available before a package is extracted. The local
updater expects:

```text
C:\ProgramData\DPE\revAgent\updater\lib
C:\ProgramData\DPE\revAgent\updater\config
```

NAS tools expect:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\lib
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\config
```

Run the local PowerShell smoke suite after touching installer/updater behavior:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-distribution-integrity.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-publish-signing.ps1
```

The smoke suite is non-admin and does not need Revit. It checks hidden launcher
exit-code propagation, WScript scheduled task action shape, targeted permission
plans, Revit-open update decisions, stable package path/layout resolution, and
public `install-self-contained.ps1` parameters.

## Revit Version Matrix

Revit version metadata is centralized in:

```text
config\revit-versions.json
```

The matrix contains target framework, build configuration, install-root
candidates, add-in path pattern, API package mappings, and payload path
expectations. The current office deployment payload supports Revit 2022 only.
Revit 2023/2024/2025 are modeled for future expansion and must remain blocked
until real payload artifacts are built and validated. Installer paths must not
pretend to deploy a version whose payload flag is false.

Use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

for a source build check. Use the same command without `-SkipPayloadCopy` only
when intentionally refreshing the 2022 bundled payload.

## Local No-Deploy Test Flow

For branch validation that must not publish to NAS:

```powershell
git branch --show-current
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm run test

cd ..\revit-api-docs-mcp
npm run test

cd ..\..
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

Aggregate non-Revit tests can also be run with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

`test-all.ps1` includes installer smoke, usage intelligence, live dashboard
helpers, the `@ts-nocheck` policy, both MCP package tests, and MCP/Revit payload
freshness checks. It also runs bridge result contract characterization checks
that reject dynamic-result double encoding, bypassed C# camelCase response
helpers, missing `resultContractVersion`, and non-idempotent canonical
normalization. Dynamic-code tests also verify that `parseJsonResult=true`
parses JSON-looking nested `result` strings and failed parsing preserves raw
text. It does not run the live Revit commandset gate.

When `src/revit-plugin/RevitMCPCommandSet` or `installer/command-payload`
changes, run the optional live commandset gate on a workstation with Revit 2022
open and an active document:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-commandset-live.ps1
```

When the same run is the representative rollout smoke, write the closure-audit
evidence directly to the NAS reports tree:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-commandset-live.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
```

This gate is intentionally separate from `test-all`: it connects to the Revit
MCP socket, status-checks before each command, and validates real commandset
behavior for `transactionMode: "auto"`, `transactionMode: "none"`, guarded
manual transaction blocking, manual rollback in `none`, and
`Newtonsoft.Json.JsonConvert` compilation. For bridge result contract changes,
also verify that dynamic object results are not double-encoded strings, native
bridge responses emit camelCase `success`, and `resultContractVersion` is
readable from the response payload and from `mcp_status` diagnostics. For
runtime-only dynamic result normalization changes, the deterministic
`bridge-result-contract-test` is the required gate; live Revit is optional
unless the native bridge payload changed.

For operator-owned junk/test models, run the focused live runtime smoke package:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-live-junk-model-smoke.ps1
```

This optional gate uses runtime tools rather than raw socket snippets. It
checks safe-code guarding, parameter visible-clear/restore when the fixture
already has a writable `Comments` value, standard schedule body write guarding,
`focus_elements`, `export_revit_view_image`, `export_revit_coordination_image`
with cleanup, and `clear_selection`. True no-value restore for built-in,
non-shared `Comments` / `ALL_MODEL_INSTANCE_COMMENTS` is treated as a Revit API
limitation; the smoke avoids creating a permanent `HasValue=true` trace when a
fixture starts at true no-value. It is
deliberately outside `test-all` and CI because it requires Revit plus a
disposable model.

Keep `src/revit-plugin/RevitMCPCommandSet` limited to the registered production
bridge commands: `send_code_to_revit`, `get_current_view_elements`,
`get_current_view_info`, `get_selected_elements`, `list_open_views`,
`activate_view`, `close_view`, `get_ui_state`, `find_elements`,
`inspect_sheet_text`, `open_existing_plan_for_element_level`, `focus_elements`,
`section_box_elements`, and `create_3d_view_for_elements`. Do not reintroduce
old unregistered create/edit/filter/tag/data-extraction command sources unless
they are deliberately promoted into the production registry and fully reviewed.
The smoke gate rejects localized or mojibake source text instead of hiding it
with a status-message sanitizer.

For large-model search changes, verify both CI-safe contracts and live Revit
behavior. CI-safe tests must prove the runtime tool schema, progressive
`find_elements` search policy, `detailLevel="minimal"` session context default,
sheet/schedule `allowExpensiveSearch` guards, telemetry search-policy fields,
and bumped tool surface version. Live validation must prove that inferred
category searches use Revit API-level collector filters rather than collecting
all instance elements, level-scoped searches continue to use the in-memory
`ResolveElementLevel` post-filter path for MEP correctness, Revit-side
`maxElapsedMs` returns partial results before socket timeout, broad verified
plan visibility requires exact targets or explicit expensive-search approval,
native `inspect_sheet_text` guards no-scope viewport scans before expensive
work, scoped sheet/viewport text-note evidence stays bounded, response pressure
returns `scanStoppedReason="max_bytes"`, schedule-cell caps return
canonical `scanStoppedReason="max_cells"` with legacy native aliases preserved
only as raw diagnostics, viewport tag requests return bounded `viewportTag`
evidence when tag text is readable, `count_annotations` can count
`viewport_text_notes` evidence from placed views, native `inspect_schedules` returns
controlled `partial=true` results for `max_cells`/`max_bytes` pressure with
`lastReadSection`/`lastReadRow`/`lastReadColumn` continuation state, and
`needs_scope` is emitted as `state="guarded"` with `reason="needs_scope"` rather
than a new incompatible state.

API-level level prefiltering for MEP elements is intentionally deferred to a
separate change. It must prove correctness for duct, pipe, flex, and other
elements whose level is resolved through fallback parameters before it can
replace the post-filter path.

This local flow does not run `publish-nas-release.ps1` and does not touch
`channels\stable.json`.

## Definition Of Done

Use this table to decide whether a development change is ready for review,
push, release, or manual Revit validation. CI-safe gates run without Revit, NAS
shares, ProgramData installs, admin rights, or live dashboard state. Local-only
gates stay manual because they need a real workstation, Revit session, NAS
access, or deployment approval.

CI-safe aggregate gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ci.ps1
```

`test-ci.ps1` copies both MCP packages to isolated temporary work folders,
restores dependencies there with `npm ci`, runs forced strict TypeScript checks
in those copies, checks the zero `@ts-nocheck` policy, verifies distribution
canonicalization/signature fixtures, verifies MCP build payload freshness with
`test-mcp-build-payload-freshness.ps1`, then runs both package `npm test`
chains from the temporary copies. The source package folders
are not used as dependency restore targets, so live ProgramData package
processes cannot lock `node_modules` cleanup. The Revit half reads
`installer/revit-payload-manifest.json`; it does not rebuild the add-in or
compare file mtimes.

| Invariant | Enforcing script/test | CI job | Local-only note |
| --- | --- | --- | --- |
| TypeScript stays strict and unmasked | `scripts/test-typescript-nocheck-policy.ps1` plus forced `tsc --noEmit --strict --noImplicitAny --strictNullChecks --useUnknownInCatchVariables` in both MCP packages | `Engineering gates` | - |
| New `@ts-nocheck` usage is blocked | `scripts/test-typescript-nocheck-policy.ps1` | `Engineering gates` | - |
| Runtime MCP package still builds and passes local characterization tests | `installer/runtime-mcp-server` `npm test` | `Engineering gates` | - |
| Revit API docs MCP package still builds and smoke-tests | `installer/revit-api-docs-mcp` `npm test` | `Engineering gates` | - |
| MCP build payloads and the Revit payload manifest match source | `scripts/test-mcp-build-payload-freshness.ps1` | `Engineering gates` | Live Revit behavior remains local-only. |
| Distribution canonical JSON and detached signature fixtures stay deterministic | `scripts/test-distribution-integrity.ps1` | `Engineering gates` | Does not publish, sign a real stable channel, or enable updater enforcement. |
| Publish-path detached signing writes verifiable signature files without real NAS or production keys | `scripts/test-publish-signing.ps1` | `Engineering gates` | Uses a temporary release root and ephemeral test key only. |
| Signed stable readiness preflight rejects unsigned, partially signed, hash-mismatched, or private-key-bearing release roots | `scripts/test-signed-stable-readiness.ps1` | `Engineering gates` | Uses a temporary release root and ephemeral test key only; does not publish to NAS or enable enforcement. |
| Rollout readiness audit classifies machine reports, source-free evidence, version fallback, and exclusions deterministically | `scripts/test-rollout-readiness.ps1` | `Engineering gates` | Uses temporary fixture reports only; does not read NAS, update machines, or connect over SSH. |
| Updater integrity defaults fail-closed when trusted release keys are present and keeps keys-free legacy compatibility only for bootstrap/test paths | `scripts/test-distribution-integrity.ps1`, `scripts/test-installer-smoke.ps1` | `Engineering gates` | Does not publish to NAS or include production private keys. |
| Signed release anti-rollback and enforce-mode metadata stay valid | `scripts/test-distribution-integrity.ps1`, `scripts/test-publish-signing.ps1`, `scripts/test-installer-smoke.ps1` | `Engineering gates` | Does not publish to NAS or include production private keys. |
| Optional signed license-seat verification stays public-key-only | `scripts/test-license-seat.ps1`, `scripts/test-installer-smoke.ps1` | `Engineering gates` | Default policy is disabled; no production license keys are included. |
| Bridge result contract stays canonical and idempotent | runtime `bridge-result-contract-test` via `npm test` | `Engineering gates` | Live Revit skew checks remain local-only. |
| Production write tools keep guard/verification contracts | runtime `write-tool-contract-test` via `npm test` | `Engineering gates` | - |
| Tool argument schema inference does not collapse to `any` | runtime `tool-inference-test` via `npm test` | `Engineering gates` | - |
| Runtime tools do not reintroduce raw PascalCase bridge response member-access | runtime `casing-member-access-test` via `npm test` | `Engineering gates` | Compatibility helpers may still read legacy casing through string-literal helper calls. |
| Usage-intelligence promotion summary and dashboard brief stay deterministic | `scripts/test-usage-intelligence.ps1` or `scripts/test-all.ps1` | No | Runs the admin add-on tests through root compatibility wrappers without Revit or NAS, but remains outside the protected `Engineering gates` job. |
| Live commandset behavior is valid in Revit | `scripts/test-commandset-live.ps1` | No | Requires Revit 2022 open with an active document. |
| Live dashboard helpers and publish backfill are valid | `scripts/test-live-dashboard.ps1` or `scripts/test-all.ps1` | No | Local-only admin add-on coverage; not part of the CI-safe gate. |
| NAS publish/update/install behavior is valid | Signed source-free CD, updater tools, and manual workstation verification | No | Protected `main` builds and validates; production publish requires manual `workflow_dispatch` with `publish_to_nas=true`. Manual publish scripts remain a controlled fallback and require NAS access. |

The GitHub Actions workflow at `.github/workflows/ci.yml` runs the
`Engineering gates` job on `push` to `main`, pull requests targeting `main`,
and manual `workflow_dispatch`. The `main` branch is protected: pull requests
are required, the `Engineering gates` status check is required, strict status
checks are enabled, direct force-push/deletion is disabled, and admin
enforcement is enabled. Treat a red `Engineering gates` check as a hard stop;
do not merge or deploy from that change.

`better-sqlite3` is installed normally in CI through `npm ci`; do not use
`--ignore-scripts` unless a CI failure proves that the sqlite native install is
the only blocking issue and the runtime tests do not load that native module.

Optional local pre-push hooks are available but are not enabled automatically:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-git-hooks.ps1
```

The hook runs `scripts/test-pre-push.ps1`, which performs the fast forced
strict TypeScript checks and the `@ts-nocheck` policy check. It is an early
local warning only; CI plus branch protection remains the authoritative gate.

## revAgent Runtime Rule

Before every non-status revAgent runtime command:

1. Call `get_revit_mcp_status`.
2. If `activeTask` is present, do not send a new command.
3. Report the active task name and elapsed time.
4. Poll only `get_revit_mcp_status` until the task clears.
5. Then send the next Revit command.

Use the compact status defaults for routine preflight. Increase `recentLimit`
up to 100 or set `includeDiagnostics=true` only when investigating a full-test,
transport, or runtime issue. The status payload includes `runtimeIdentity` (`runtimeVersion`,
`schemaVersion`, `toolSurfaceVersion`, `processStartedAtUtc`,
`buildTimestampUtc`, and `buildHash`) and, for normalized Revit DLL payloads,
`resultContractVersion`; check it when a workstation may be running an older
runtime after an update or restart.

Do not run revAgent runtime commands in parallel. The only exception is
status polling while a task is already active.

This rule catches MCP tasks, not every manual user action in Revit. If the user
is actively selecting, saving, syncing, or editing, wait for user instruction.

## Local Install And Live Test

For manual local install from the repo, close Revit first:

```powershell
$RepoRoot = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022
```

For office-style testing, prefer the NAS GUI updater:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\Install-revAgent-Updater-GUI.cmd
```

Live smoke test after install:

1. Open Revit 2022.
2. If Revit asks about unsigned add-in publisher, choose `Always Load`.
3. Confirm only the intended Revit process is open.
4. Call `get_revit_mcp_status`.
5. Call `get_revit_session_context`.
6. Run one small read-only count task.
7. Confirm `get_revit_mcp_status` shows the task as `completed`.
8. For command-payload transaction changes, confirm `transactionMode: "auto"`
   uses a wrapper-managed transaction, `transactionMode: "none"` runs without
   that wrapper, and a manual Revit `Transaction` inside `auto` returns
   `guarded` rather than `failed`.
9. For bridge result contract changes, confirm dynamic object results are not
   returned as double-encoded strings, native bridge command responses use
   camelCase `success`, and `resultContractVersion` is visible in both the
   command response payload and `mcp_status`. For runtime-only dynamic result
   parsing changes, confirm deterministic tests cover `parseJsonResult=true`
   nested JSON parsing and raw-string preservation on failed parsing.
10. For rollout closure evidence, run `scripts\test-commandset-live.ps1` with
    `-ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"` so the
    current stable live-smoke result is written to
    `reports\rollout\live-smoke-latest.json`.
10. Confirm `revit-api-docs` responds to a small search such as
   `FilteredElementCollector`.
11. For transport-sensitive changes, run a large read-only marker/checksum probe
    and confirm the returned marker matches the end of the payload. Do not rely
    only on the status window duration for transport validation.

The current production status window behavior:

- running task: visible warning and elapsed time
- completed, guarded, or failed task: stays visible until user clicks `OK`
- close button after completion acts as acknowledge/hide
- status window should not steal foreground focus from other apps
- guarded task: expected safety block, such as rejecting a manual Revit
  transaction inside `transactionMode: "auto"`; it should read as guarded/warning
  behavior, not as a red model-operation failure
- recent task history is selectable and resizable
- recent history uses compact state symbols: `✓` for completed, `!` for guarded
  safety blocks, and `✕` for failed tasks. It shows total Revit-side duration
  plus request size, for example:
  `17:19:07  ✓  Final metric UI log probe  (2.9s)  [1 MB]`
- detailed transport metrics remain available through
  `get_revit_mcp_status(includeDiagnostics=true)` and in the add-in log:
  `C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin\Logs\mcp_YYYYMMDD.log`

Transport metrics in logs include `framing`, `requestBytes`, `receiveMs`,
`parseMs`, `executeMs`, `responseBytes`, and `totalMs`. The status window is
deliberately simpler so users see only the information needed during normal
work.

## Git Commit And Push

Typical development flow:

```powershell
git status --short
git switch -c codex/<short-topic>
git add <changed-files>
git commit -m "Short imperative message"
git push -u origin codex/<short-topic>
gh pr create --base main --head codex/<short-topic>
```

Merge the pull request only after `Engineering gates` and GitGuardian are green,
the automatic Claude Code Review job has run, and actionable review comments are
addressed. Do not add manual `@claude`, `@codex`, or `@gemini` review comments;
this repository uses the GitHub Actions Claude review job as the review signal.
After merge, update the local main branch:

```powershell
git switch main
git pull --ff-only
```

For any change that reaches protected `main`, including a direct push if branch
protection allows one, the signed source-free CD workflow builds and validates
the signed release root but does not publish production NAS stable. Treat
manual `workflow_dispatch` with `publish_to_nas=true` as the production publish
trigger. Verify the GitHub Actions CD run plus `channels\stable.json` before
any manual rollout instruction, and use the rollout-hold process above if
scheduled workstation updates must be paused before verification.

Keep commits coherent:

- source and matching payload in the same commit
- installer/updater behavior and docs in the same commit when useful
- no unrelated cleanup mixed into a production fix

Direct `main` pushes are no longer the normal development path. Never deploy
from an unmerged branch, a red CI run, or an uncommitted production change
unless it is an explicit temporary test package with `-AllowDirty`.

## NAS Deployment Model

Canonical NAS root:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy
```

Temporary compatibility root:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy
```

Layout:

```text
channels\
  stable.json
  stable.sig.json
releases\
  <version>\
    revit-mcp-skill-<version>.zip
    manifest.json
    manifest.sig.json
reports\
  machines\
    <computer>\
      latest.json
      install-latest.json
      update-latest.json
      logs\
tools\
```

Production stable releases publish through manual `workflow_dispatch` on the
signed source-free CD workflow with `publish_to_nas=true`. Keep
`allow_rollback=false` for normal forward publishes. Set `allow_rollback=true`
only for deliberate signed rollback, same-sequence repair, or the one-time
legacy stable bootstrap when the current NAS `stable.json` predates
`releaseSequence`.

During the NAS rename transition, set the protected production publish variable
`REVAGENT_NAS_RELEASE_ROOT` to the canonical `revAgent-deploy` root and set
`REVAGENT_NAS_COMPAT_RELEASE_ROOTS` to the old `revit-mcp-deploy` root. The CD
job publishes the exact same signed release to each configured root; channel
metadata remains portable because it uses relative package and manifest paths.

Use the manual publish script only for controlled recovery/backstop work from a
clean repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\nas\publish-nas-release.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy" `
  -Channel stable
```

Verify channels:

```powershell
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\channels\stable.json"
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\channels\stable.json"
```

Run the read-only rollout readiness audit before closing an office rollout or
before telling operators that every in-scope machine is finished:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-rollout-closure-audit.ps1 `
  -ConfigPath "C:\ProgramData\DPE\revAgentOps\rollout-readiness.json"
```

This wrapper calls `scripts\check-rollout-readiness.ps1`, writes a timestamped
JSON snapshot under `C:\ProgramData\DPE\revAgentOps\readiness`, and prints the
stable version, ready state, action count, and live-smoke state. Pass
`-FailOnActionRequired` when a non-zero exit code should block a rollout
handoff until all audit actions are clear.

The underlying audit reads only `channels\stable.json`, `reports\machines`,
`reports\live`, source-free migration reports, copied logs, and optional live
Revit smoke evidence. It does not update workstations, run migration, publish
stable, or connect over SSH. Use `-OutputJson` for machine-readable handoff, or
`-OutputPath` to write a local JSON snapshot for review. Start from
`config\rollout-readiness.sample.json`, keep the office-specific copy outside
Git, and record intentionally retired or unreachable machines in
`outOfScopeMachines` with a short `reason`. Record the representative
post-update live Revit smoke result in `liveSmokeEvidence`, or write the same
shape to `reports\rollout\live-smoke-latest.json`. The smoke evidence must pass
and identify the current stable version or commit before the audit reports the
rollout as ready. The audit also classifies each machine's latest
`paths.channelManifestPath` as `canonical`, `legacy`, or `unknown`; legacy or
unknown channel evidence blocks compatibility-root retirement and produces an
action item unless another higher-priority machine action already applies. For
a one-off run, `-ReleaseRoot`, `-ExpectedMachines`, and `-OutOfScopeMachines`
can still be passed directly.

Publishing refreshes `tools\` on the NAS. Workstations should launch the tools
from the NAS share, not from copied old script bodies when possible.

## GitHub Actions Signed Source-Free CD

The protected CD workflow is `.github/workflows/signed-source-free-cd.yml`.
It runs automatically when protected `main` is updated and builds/validates the
signed release root without publishing. Manual dispatch from `main` defaults to
build/validate only unless the operator sets `publish_to_nas=true`. The publish
job is separated behind the `revagent-production-publish` GitHub environment.

Chosen production signing model:

- Use an office-controlled self-hosted Windows runner, normally selected with
  `["self-hosted","Windows","revagent-cd"]`.
- Keep the private release signing key as a local file on that runner, outside
  the Git checkout and outside NAS `tools\`.
- Store only public release verification keys in
  `release-trusted-keys.json`; the CD producer copies that public file into
  release `tools\config\release-trusted-keys.json` for workstation updaters.
- Name production signing keys with a stable key id such as
  `revagent-prod-rsa-2026q3`; rotate by adding the new public key before
  signing releases with the new private key, then remove old trust only after
  all workstations have accepted a newer signed baseline.
- Keep the encrypted/offline private-key backup under the release owner's
  control. Do not put private release keys, license-signing keys, seat secrets,
  or GitHub write tokens in Git, release ZIPs, NAS `tools\`, updater config, or
  workstation payloads.

Required protected environment variables:

```text
revagent-release-signing:
  REVAGENT_RELEASE_SIGNING_PRIVATE_KEY_PATH
  REVAGENT_RELEASE_SIGNING_KEY_ID
  REVAGENT_TRUSTED_RELEASE_KEYS_PATH

revagent-production-publish:
  REVAGENT_NAS_RELEASE_ROOT
  REVAGENT_TRUSTED_RELEASE_KEYS_PATH
```

Current production signing setup on this workstation:

```text
key id:
  revagent-prod-rsa-2026q3
private key:
  C:\ProgramData\DPE\revAgentReleaseSigning\private\revagent-prod-rsa-2026q3-private.xml
public trusted keys:
  C:\ProgramData\DPE\revAgentReleaseSigning\public\release-trusted-keys.json
public key fingerprint:
  32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33
```

The key id and private-key filename above are current rotation examples, not
permanent literals. Update both values together when rotating production
release-signing keys.

The GitHub environments `revagent-release-signing` and
`revagent-production-publish` exist and their path/key variables are set.
Reviewer and wait-timer protection rules could not be enabled on the current
GitHub repo plan; GitHub returned billing-plan 422 errors when those protection
rules were requested. Until reviewer protection is available, the human gate is
the protected PR review/CI/merge decision for `main`; after merge, signed CD
validates automatically, and production NAS publish requires explicit manual
workflow dispatch with `publish_to_nas=true`. The optional manual
`allow_rollback=true` input is reserved for signed rollback, same-sequence
repair, or the first legacy stable bootstrap when existing NAS stable metadata
has no `releaseSequence`. The NAS publish wrapper still validates
`stable.candidate.json` on the target release root before replacing
`stable.json`.

The build job runs `scripts/invoke-signed-source-free-cd.ps1`. That wrapper
runs `scripts/test-ci.ps1`, uses `publish-nas-release.ps1` against a staging
release root, requires release signatures, copies public trusted keys into
`tools\config`, and runs `scripts/check-signed-stable-readiness.ps1`.

The workflow keeps the validated signed release root in local staging under
the self-hosted runner workspace and passes that path to the publish job. This
avoids coupling the production handoff to GitHub Actions artifact storage
quota while keeping the signing and publish jobs separated by environment and
by the protected `main` merge gate. Production publish is manual-dispatch only:
`main` push builds and validates the signed release root, then removes staging
when publish was not requested. The publish job runs
`scripts/publish-signed-source-free-release-to-nas.ps1`; it does not rebuild or
re-sign. It copies the release and tools to NAS, validates
`stable.candidate.json` on the NAS root with active-release artifact hygiene,
blocks stable `releaseSequence` rollback or equal-sequence repair unless
`allow_rollback=true` / `-AllowRollback` is passed deliberately. The same
explicit flag is required for a one-time legacy stable bootstrap when the
current NAS `stable.json` exists but has no `releaseSequence`; unreadable or
invalid current metadata still fails closed. The publisher then promotes
`stable.sig.json` and `stable.json` with rollback files retained until the
post-publish readiness check passes. Publish rollback also restores the
previous `tools` payload and the replaced `releases\<version>` directory when
`-Force` overwrote one. After a successful publish, transient `.previous.*`
channel backups and payload rollback backups are removed; operator recovery should use the
versioned NAS `releases\` archive rather than relying on those promotion
scratch files.
Active-release scope checks the candidate release package and current `tools\` payload without
blocking on historical legacy release ZIPs already present under the existing
NAS `releases\` archive. Use the default full release-root readiness scan only
when intentionally auditing or cleaning that historical archive. New signed
channel metadata uses relative paths so the same signed release root can move
from CD staging to NAS without changing the signed JSON. Because the handoff is
local to the self-hosted runner, the selected runner label set must identify
the office runner that owns both signing-key and NAS access.

The versioned release ZIP is an allowlisted user pack. It must not contain the
repo root, `src/`, root `docs/`, developer tests, repo metadata, `.pdb`, `.mdb`,
or source maps. `publish-nas-release.ps1` stages the hardened MCP release
bundles as single-file `build\index.js` payloads with runtime-only npm
manifests, Revit DLL payloads, installer/updater helpers, release metadata, and
`installer/codex-user` orchestration files, then fails if source/developer,
managed debug-symbol, or unhardened JavaScript artifacts are detected in the
staged package.

Production machines must stay on the default `codexInstructionPolicy` value
`managed-user-pack`, so installed Codex `SKILL.md` and `AGENTS.md` come from
`installer/codex-user`. A developer workstation may be marked with
`codexInstructionPolicy=preserve-local` and optional `machineRole=developer` in
`updater-config.json`. That policy preserves local machine/user Codex
instruction files and their hardlink/junction integration only; it must not be
used as a source-free bypass for package/runtime/updater cleanup or signed
release verification.

For existing workstations that may already contain source-bearing managed
payloads, run `migrate-source-free-install.ps1 -Mode dryRun` first. Commit mode
launches `update-from-nas.ps1 -SourceFreeMigration` in a child PowerShell
`-File` process, disables unchanged-payload skips, refreshes runtime/docs and,
unless policy preserves local instructions, Codex instruction integration, cleans
managed source/developer artifacts from package/runtime/Codex skill/updater backup
locations, and writes a JSON migration report. The child
`-File` launch keeps updater transcript headers readable even when migration is
orchestrated remotely. If `revAgent Auto Update` was already disabled before
migration, commit mode restores that disabled state after the updater/installer
refresh. It must not delete Codex sessions, memory, Revit models, or user
project folders.
When `codexInstructionPolicy=preserve-local`, migration omits Codex instruction
roots from inventory/cleanup and records `codexInstructionCleanupSkipped=true`
while still cleaning package/runtime/updater backup artifacts.

Workstation rollback uses the signed NAS release archive, not local workstation
package backups. Every normal updater run clears the updater package backup
folder and stale cached release ZIPs before package replacement, then removes
the current managed package directly once the replacement package has already
been downloaded, signature/hash checked, and extracted. During the revAgent
brand transition, the first updater run that has not yet written
`revagent-clean-install-transition.json` also forces a full managed payload
repair and writes the marker only after a successful install. Later updates keep
the same local-backup-disabled policy.

Normal stable updater entrypoints, including the standalone GUI launcher, check
the managed source/developer artifact inventory before update/repair work
starts. If artifacts remain, the GUI exposes a one-time migration path. If the
installed local updater supports migration, the GUI runs
`update-from-nas.ps1 -SourceFreeMigration` after operator confirmation. If the
installed local updater is too old or lacks `migrate-source-free-install.ps1`
and `installer/lib/RevAgent.SourceFreeMigration.psm1`, the GUI falls back to the
installer bootstrap path and passes `-RunSourceFreeMigration` to
`install-updater-task.ps1`. That refreshes the local updater tools first and
then runs the migration immediately in the same confirmed flow. If the
inventory is already clean, migration does not run again and the machine follows
the normal stable update path. Non-GUI updater runs still stop with
`source-free-migration-required` and write a report instead of replacing the
package without explicit migration mode.

Distribution integrity support is now active when trusted release keys are
present. `installer/lib/RevAgent.DistributionIntegrity.psm1` owns the canonical
JSON and detached signature helper surface, while
`scripts/test-distribution-integrity.ps1` proves valid and tampered channel and
release-manifest fixtures. `publish-nas-release.ps1` can write
`manifest.sig.json` and `stable.sig.json` when `-SigningPrivateKeyPath` and
`-SigningKeyId` are provided; private keys must stay outside the repo and NAS
tools. The updater imports the local helper before caching a package. Trusted
release keys make the default policy `enforce`; unsigned fallback remains only
for keys-free legacy bootstrap/test paths. Once a workstation accepts any
signed release sequence, later unsigned releases are rejected and the locally
stored `highestAcceptedReleaseSequence` is never lowered.
If an enforce-pinned workstation loses `release-trusted-keys.json`, the updater
stays fail-closed and writes a structured `trusted_keys_missing` distribution
integrity report. Restore the public key file by running Install/Repair from a
NAS tools payload that includes `tools\config\release-trusted-keys.json`; do
not lower policy to `compatibility` as a recovery step.

Before a signed stable baseline or fail-closed policy change, run the read-only
preflight against the candidate release root and production public release-key
file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-signed-stable-readiness.ps1 `
  -ReleaseRoot "\\dpe-nas\...\revAgent-deploy" `
  -TrustedKeysPath "C:\secure\release-trusted-keys.json" `
  -OutputJson
```

The preflight verifies channel and release-manifest detached signatures in
`enforce` mode, checks ZIP SHA256 against signed metadata, requires a positive
`releaseSequence`, scans the release root and ZIP for source/developer/debug
artifacts, and fails if obvious private signing material appears under the
release root. It does not publish or change workstation policy.

For an existing NAS root that still contains older source-full release ZIPs,
check the currently selected signed stable release and `tools\` payload without
failing on historical archives:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-signed-stable-readiness.ps1 `
  -ReleaseRoot "\\dpe-nas\...\revAgent-deploy" `
  -TrustedKeysPath "\\dpe-nas\...\revAgent-deploy\tools\config\release-trusted-keys.json" `
  -ArtifactScanScope activeRelease `
  -OutputJson
```

Signed release enforcement uses `releaseSequence` metadata in both
`stable.json` and `manifest.json`. The updater persists
`highestAcceptedReleaseSequence` in `installed.json` and rejects older signed
channel replay during normal execution. Emergency signed rollback is available
only through the explicit local updater flag `-AllowSignedReleaseRollback`; the
scheduled updater does not pass that flag.

License/seat verification is optional and disabled by default. The updater can
load a signed `revagent-license.json` plus `revagent-license.sig.json` from the
configured license path, and public license verification keys from updater
config or `config/license-trusted-keys.json`. `audit` policy records missing,
expired, or tampered license evidence without blocking; `enforce` blocks before
package replacement. License private keys must stay outside the repo, package,
NAS tools, updater config, and workstation install.

Large offline dependency payloads are local/NAS-side assets, not Git assets:

```text
installer\nas\dependencies\
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\dependencies\
```

The local dependency folder is ignored by Git. Keep it populated on the
development workstation before publishing. `publish-nas-release.ps1` copies it
to NAS `tools\dependencies\`, while excluding it from the versioned release ZIP.

Release ZIP layout:

- canonical package folder: `installer/`
- removed compatibility aliases are not regenerated in new releases

Dependency restore note:

- The runtime server lives outside the managed package folder, but
  `revit-api-docs-mcp` lives inside `C:\ProgramData\DPE\revAgent\package`.
  Every versioned update replaces that package folder, so the updater must
  restore `installer\revit-api-docs-mcp\node_modules` and the
  `.revagent-npm-dependencies.json` marker even when the docs payload itself is
  unchanged and the Revit API index rebuild is skipped.

## Workstation Install And Update

Stable workstation GUI:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\Install-revAgent-Updater-GUI.cmd
```

Single-file desktop launchers:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\revAgent Updater STABLE.cmd
```

Use the single-file launchers when copying a `.cmd` to a workstation desktop.
The single-file launchers try `revAgent-deploy` first and fall back to the
legacy `revit-mcp-deploy` root during the transition. The generic
`Install-revAgent-Updater-GUI.cmd` is meant to run from the NAS `tools\` folder
because it expects `Install-revAgent-Updater-GUI.ps1` beside it.

The GUI installs or refreshes the local updater and then runs an initial update.
The updater writes:

```text
C:\ProgramData\DPE\revAgent\updater\installed.json
C:\ProgramData\DPE\revAgent\updater\last-update-report.json
C:\ProgramData\DPE\revAgent\updater\logs\
```

The updater keeps only the latest 10 `.log` files in the managed log folder.
Install and update runs prune older logs automatically.
Each install/update also publishes a per-machine support record to NAS:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports\machines\<computer>\
  latest.json
  install-latest.json
  update-latest.json
  logs\
```

The NAS machine folder keeps the latest two copied operation logs. The JSON
records include the operation method, such as GUI install, GUI update,
scheduled update, or install/repair. `latest.json` is dashboard-ready: it
contains machine/user/time, operation type, release version/commit/package SHA,
previous and installed versions, status, update diagnostics, the NAS log path,
and a local install-state summary.

Admin dashboard installs must read this canonical reports root. If
`C:\ProgramData\DPE\revAgent\addons\dashboard\config\dashboard.json` still
points at `\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports`, rerun
the dashboard add-on installer from the canonical `revAgent-deploy` tools
payload or restart the add-on with its current start script; both paths migrate
legacy dashboard config values back to `revAgent-deploy`.

The workstation install root is:

```text
C:\ProgramData\DPE\revAgent
```

Important deployed locations:

```text
C:\ProgramData\Autodesk\Revit\Addins\2022\revAgent.addin
C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin
C:\ProgramData\DPE\revAgent\commands\CommandSet
C:\ProgramData\DPE\revAgent\runtime
C:\ProgramData\DPE\revAgent\package
C:\ProgramData\DPE\revAgent\codex
```

If registering a scheduled task fails because the user is not elevated, the
bootstrap creates a Startup-folder fallback:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\revAgent Auto Update.vbs
```

The preferred updater registration is a per-user Scheduled Task. It runs once
per day at 12:00 local time. If Scheduled Task registration is blocked, the
Startup fallback launches a hidden `auto-update-loop.ps1` process for the user
session and follows the same daily 12:00 schedule. New installs remove legacy
`Revit MCP Auto Update.cmd` / `.vbs` fallback launchers. Manual update and
install/repair remain available from the updater GUI and command launchers.

The GUI requests admin rights immediately at startup. If Windows opens the GUI
with different admin credentials, user-profile Codex integration may be written
under that admin profile instead of the operator profile. Prefer approving UAC
with the same Windows user when possible.

When user-profile Codex integration is enabled, install/update writes the
standard Codex memory settings and normalizes `service_tier = "fast"` in
`%USERPROFILE%\.codex\config.toml` idempotently. The helper reuses existing
top-level keys plus `[features]` and `[memories]` sections, and must not append
duplicate blocks on repeated runs.
It also writes a managed revAgent UTF-8 block to both Windows PowerShell and
PowerShell 7 user profile files, and sets the current user's default console
code page to UTF-8. This keeps Turkish text in `AGENTS.md`, `SKILL.md`, and
MCP/Revit output readable in Codex PowerShell terminals. Installer, updater,
updater-task installer, and migration entrypoints also set UTF-8 in the current
process before writing transcript/log output, because scheduled or remote
automation commonly launches PowerShell with `-NoProfile`.
Under `preserve-local`, install/update leaves the existing machine AGENTS file,
machine skill directory, user AGENTS hardlink, and user skill junction/copy in
place. Codex memory and UTF-8 config writes remain enabled unless
`-SkipCodexUserIntegration` is explicitly passed.

Background updater notifications:

- `deferred-revit-close-required`: user must save/sync, close Revit, and rerun
  the updater because Revit-loaded payload files changed.
- `updated`: background update completed.
- Notifications are throttled per version/status; default throttle is 240
  minutes.

## Revit-Close Update Policy

The updater is component-aware.

The release manifest includes `updatePolicy.revitClosedRequiredComponentKeys`
for Revit-loaded files. These include the Revit add-in DLLs, command payload,
command manifests, and command runtime assemblies.

Update behavior:

- If Revit-loaded files changed and Revit is running, the updater defers.
- It never auto-closes Revit.
- The message tells the user to save/sync, close Revit, and rerun the updater.
- If no Revit-loaded files changed, the updater can apply non-Revit payload
  updates while Revit is open.
- In that case it passes `-SkipRevitPayloadInstall` to the installer so active
  Revit add-in and command DLL files are left untouched.
- The updater compares actual installed Revit payload file hashes, not only the
  stored installed version. This catches stale Revit DLLs even when the package
  version already matches.

This policy is critical for large office models: do not require users to close
Revit for skill/docs/runtime/updater-only changes.

## Cleanup And Uninstall Safety

The installer cleans only known revAgent/RevitMCP-owned locations. It must not
delete:

- Autodesk Revit program files
- Windows system folders
- broad user profile folders
- broad workspace roots
- official Revit add-in root folders themselves

Known cleanup targets include the revAgent/RevitMCP add-in manifest, old
user-profile add-in payloads, old local command folders, managed runtime
targets, active skill backup folders, legacy `.codex` backup artifacts, and
known legacy runtime folders. Normal install/update must not create new
timestamped `.codex\AGENTS.md.backup-*`, `.codex\config.toml.backup-*`, or
`.codex\skill-backups` entries.

Uninstall command:

```powershell
powershell -ExecutionPolicy Bypass -File ".\installer\install-self-contained.ps1" -RevitVersion 2022 -Uninstall
```

Use `-RemoveAgents` only when global/workspace `AGENTS.md` should also be
removed.

## Diagnostics

Check installed version:

```powershell
Get-Content -Raw "C:\ProgramData\DPE\revAgent\updater\installed.json"
```

Check last update report:

```powershell
Get-Content -Raw "C:\ProgramData\DPE\revAgent\updater\last-update-report.json"
```

Check logs:

```powershell
Get-ChildItem "C:\ProgramData\DPE\revAgent\updater\logs" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10
```

Check whether Revit is still running:

```powershell
Get-Process -Name Revit -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,MainWindowTitle
```

Compare deployed plugin DLL with package DLL:

```powershell
$installed = "C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin\revAgentPlugin.dll"
$package = "C:\ProgramData\DPE\revAgent\package\installer\revit-plugin\revAgentPlugin\revAgentPlugin.dll"
(Get-FileHash -Algorithm SHA256 $installed).Hash
(Get-FileHash -Algorithm SHA256 $package).Hash
```

Compare deployed command DLL with package DLL:

```powershell
$installed = "C:\ProgramData\DPE\revAgent\commands\CommandSet\revAgentCommandSet.dll"
$package = "C:\ProgramData\DPE\revAgent\package\installer\command-payload\revAgentCommandSet.dll"
(Get-FileHash -Algorithm SHA256 $installed).Hash
(Get-FileHash -Algorithm SHA256 $package).Hash
```

Check MCP registrations:

```powershell
codex mcp list
```

Expected entries:

- `revit-mcp`
- `revit-api-docs`

If `list_revit_instances` shows an old Revit process, close all Revit windows
and check `Get-Process -Name Revit` again before reinstalling or retesting.

## Stable Channel

Use `stable` for all office deployment after local/manual validation. There is
only one deployment channel.

Do not assume the latest commit is the deployed version. Read the channel JSON:

```powershell
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\channels\stable.json"
```

## Documentation Rules

When behavior changes, update the relevant docs in the same commit:

- `CHANGELOG.md` for user-visible or deployment-visible changes
- `README.md` for main repo orientation
- `docs/DEVELOPER_RUNBOOK.md` for development and release process changes
- `installer/nas/README.md` for workstation updater workflow changes
- `SKILL.md` and `AGENTS.md` for live revAgent coordination rules
- Product-facing docs should say `revAgent`; exact implementation identities
  should stay unchanged when they are tool, path, manifest, package, or server
  names.

This runbook should stay operational and command-oriented. Avoid vague history.
Write down exact paths, exact commands, and the current source of truth.
Completed one-off planning documents should not remain in the active docs set.
After their durable decisions are reflected in `README.md`,
`docs/PLATFORM_ARCHITECTURE.md`, `docs/DEVELOPER_RUNBOOK.md`,
`docs/REPOSITORY_STRUCTURE.md`, `SKILL.md`, `AGENTS.md`, or `CHANGELOG.md`, keep
local copies only under ignored `docs/_retired/` if they are still useful for
manual reference. Do not force-add retired audit or plan files to a PR; copy
the durable decision into the active docs instead.
