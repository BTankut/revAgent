# Developer Runbook

This file is for developers and code assistants. It is not an end-user
installation guide. Its purpose is to preserve the operational context needed
to continue development, release, and office deployment from any workstation
that can clone this repository and reach the NAS share.

## Canonical Sources

- Product name: `revAgent`
- Target GitHub repository: `BTankut/revAgent`
- Local development path on the current workstation:
  `C:\Users\BT\Projects\revAgent`
- Main branch: `main`
- Office deployment source:
  `\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy`
- Standard workstation install root:
  `C:\ProgramData\DPE\revAgent`

GitHub is the source history. The NAS share is the deployment source read by
office workstations. A normal feature-branch `git commit` or `git push` does
not deploy anything by itself. A protected `main` update starts signed
source-free CD build/validation but publishes neither channel. Pilot and stable
NAS changes require separate, mutually exclusive manual workflow dispatches.

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
revAgent/
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
git clone https://github.com/BTankut/revAgent.git C:\Users\BT\Projects\revAgent
cd C:\Users\BT\Projects\revAgent
git status
git branch --show-current
```

Expected branch: `main`.

Required local tools for full development:

- Git for Windows
- Autodesk Revit 2022
- Node.js 20 or newer
- ChatGPT desktop app with Codex enabled, or another MCP/skill-capable host
- PowerShell 5.1 or newer
- Visual Studio/MSBuild tooling if rebuilding the Revit add-in source
- Access to `\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy` for office
  publishing and workstation updater tests. Legacy `revit-mcp-deploy` access is
  only needed for explicit diagnostics or cleanup of the retired compatibility
  root.

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
12. After a separately approved manual dispatch, verify the exact signed
    channel, release manifest, ZIP path/hash, and authorized machines. Use
    `publish_to_pilot=true` for the isolated DESKTOP-OKNV128/NET01 cohort;
    `publish_to_nas=true` is a later stable/fleet action. The daily task is
    audit-only; payload installation remains a manual GUI/UAC action.

Useful baseline commands:

```powershell
cd C:\Users\BT\Projects\revAgent
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

The daily `revAgent Auto Update` task is an audit/notification surface only. It
must invoke `update-from-nas.ps1 -AuditOnly`; it does not grant install authority
and therefore does not need to be disabled to hold a release. If an older task
still performs writes, treat that workstation as legacy: disable or repair the
task before publishing and do not count it as rollout-ready.

A rollout stays held until the protected PR is merged, signed source-free CD is
green, production publish is explicitly dispatched, and the signed NAS
version/hash is confirmed. Run the manual GUI on one approved pilot, verify
both privilege phases and new-ChatGPT-task acceptance, then authorize manual
GUI updates on the remaining online machines. Record powered-off machines as
pending and skip them rather than retrying during the rollout window.

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

When `src/revit-plugin/revAgentCommandSet` or `installer/command-payload`
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

Do not run the loose NAS `tools\test-commandset-live.ps1` copy. Use a clean
repository checkout or an independently protected local coordinator copy; the
SSH wrapper stages the exact local helper over SCP before execution.

For the standard NET01 representative smoke, run the coordinator-side SSH
wrapper instead of manually opening Revit. First run the open/model gate; it
opens the installed Revit 2022 sample model in the logged-on workstation
session, waits for the local bridge, and verifies through revAgent that the
expected model and an active view are loaded:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-live-smoke-over-ssh.ps1 `
  -TargetsPath C:\ProgramData\DPE\revAgentOps\fleet.json `
  -Computer NET01 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy" `
  -OpenOnly
```

After that gate passes, rerun without `-OpenOnly`; the wrapper stages the
current live helper, runs the smoke helper, and publishes the same closure
evidence:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-live-smoke-over-ssh.ps1 `
  -TargetsPath C:\ProgramData\DPE\revAgentOps\fleet.json `
  -Computer NET01 `
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

Keep `src/revit-plugin/revAgentCommandSet` limited to the registered production
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
restores dependencies there with `npm ci`, and process-locally forces
`npm_config_ignore_scripts=false` for that restore before returning the caller's
environment to its previous state. This prevents a self-hosted runner's
user-level npm configuration from silently skipping native lifecycle installs
such as `better-sqlite3`. It then runs forced strict TypeScript checks in those
copies, checks the zero `@ts-nocheck` policy, verifies distribution
canonicalization/signature fixtures, verifies MCP build payload freshness with
`test-mcp-build-payload-freshness.ps1`, and runs both package `npm test` chains
from the temporary copies. The source package folders
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
| NAS release ACL seal/unseal is fail-closed, publisher-bounded, link-safe, and preserves the writable reports boundary | `scripts/test-nas-release-acl.ps1` | `Engineering gates` | Uses a disposable local NTFS fixture only; it never reads or mutates the live NAS. |
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
| NAS publish/update/install behavior is valid | Signed source-free CD, updater tools, and manual workstation verification | No | Protected `main` builds and validates. Pilot and stable are separate manual dispatches. The local artifact producer is never a canonical NAS writer; only the hardened signed-root publisher may write NAS. |

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
The workstation updater applies the same trust boundary to production
dependencies: it invokes `npm-cli.js` with the exact Node selected for MCP
registration, temporarily forces `npm_config_ignore_scripts=false`, restores
the previous process environment in `finally`, and keys dependency markers and
cache entries by Node modules ABI, N-API, platform, and architecture. Before an
installed tree or cache is accepted, `better-sqlite3` must load under that Node
and open an in-memory database. Missing or incompatible bindings invalidate the
entry and trigger a clean install/rebuild; validation failure after rebuild is
fatal and must not write a current marker or cache.

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

Never elevate `install-self-contained.ps1` or a bootstrap installer directly
from the repo. Close Revit and use the protected local launcher; it verifies
the signed canonical release, runs only the bounded machine phase under UAC,
and resumes Codex integration in the original unelevated process:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
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
10. For rollout closure evidence, prefer
    `scripts\invoke-live-smoke-over-ssh.ps1 -Computer NET01 -ReleaseRoot
    "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy" -OpenOnly` first, so the
    coordinator opens the Revit 2022 sample model in the logged-on workstation
    session and verifies the expected document through revAgent before full
    smoke. Then rerun without
    `-OpenOnly` to write the current stable live-smoke result to
    `reports\rollout\live-smoke-latest.json`. If Revit is already open on the
    smoke machine, `scripts\test-commandset-live.ps1` can still be run directly
    with the same `-ReleaseRoot`.
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
the signed release root but publishes neither NAS channel. Treat manual
`workflow_dispatch` with `publish_to_pilot=true` as the isolated developer/NET01
pilot trigger; `publish_to_nas=true` is the separate stable/fleet trigger.
Verify the GitHub Actions CD run plus the selected signed channel before any
manual rollout instruction. Audit-only scheduled tasks do not need to be
paused; repair any legacy task that still has payload-write behavior.

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

Retired compatibility root:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy
```

Layout:

```text
channels\
  pilot.json
  pilot.sig.json
  stable.json
  stable.sig.json
releases\
  <version>\
    revAgent-<version>.zip
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

Signed pilot releases publish through manual `workflow_dispatch` with
`publish_to_pilot=true`. The cohort is exactly DESKTOP-OKNV128 and NET01; the
operation may create only a pilot-namespaced release and the signed pilot
channel pair. It must prove stable metadata, the active stable release, and the
shared tools tree stayed unchanged. Production stable/fleet release is a later,
separately approved `publish_to_nas=true` dispatch. Its 13-file managed
shared-tools/operator surface now uses the active transactional exact-handle
create-new/compare-and-swap/rollback path and is no longer disabled by the
former transaction gap.

Set the protected production publish variable `REVAGENT_NAS_RELEASE_ROOT` to
the canonical `revAgent-deploy` root. The CD job publishes only to that
canonical root after compatibility-root retirement; channel metadata remains
portable because it uses relative package and manifest paths.

`installer\nas\publish-nas-release.ps1` produces only a local signed staging
root. Direct UNC, mapped-network, canonical-NAS, and reparse-redirected output
are forbidden, including for recovery/backstop work. Every canonical NAS write
must consume an already signed and validated local staging root through
`scripts\publish-signed-source-free-release-to-nas.ps1`; use the protected
workflow as the normal entrypoint.

Verify channels:

```powershell
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\channels\stable.json"
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
Desktop launcher evidence is also part of compatibility-root retirement:
scan each in-scope machine, then aggregate the machine evidence before running
the closure audit. A single clean machine is not sufficient evidence for the
office rollout.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-desktop-launcher-evidence.ps1 `
  -Mode ScanLocal `
  -ReportsRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-desktop-launcher-evidence.ps1 `
  -Mode Aggregate `
  -ConfigPath C:\ProgramData\DPE\revAgentOps\rollout-readiness.json
```

Do not execute the loose NAS copy of this helper. Use the repository script or
an independently protected local coordinator copy, and stage it to source-free
workstations through the bounded coordinator workflow.
The aggregate record is written to
`reports\rollout\desktop-launcher-latest.json`. The closure audit also reads
per-machine records under
`reports\machines\<machine>\desktop-launcher-latest.json`, so a current
per-machine scan can complete coverage when the aggregate record is stale or
partial. Compatibility-root retirement still requires every in-scope machine to
resolve to passing evidence with `missingMachineCount=0`,
`failedMachineCount=0`, `legacyLauncherCount=0`, and
`legacyRootReferenceCount=0`. `ScanLocal` defaults to the current user's
Desktop, the public Desktop, and every local
`C:\Users\*\Desktop` or `C:\Users\*\OneDrive*\Desktop` folder it can read, so
SSH/admin runs still inspect the operator desktop launchers unless
`-LauncherPath` is used to narrow the scan.
When the audit asks for `run_source_free_dry_run_inventory`, run the local
migration tool in `dryRun` mode with `-ReportsRoot` pointing at the canonical
NAS reports root. It publishes `source-free-migration-latest.json` as durable
readiness evidence without overwriting the dashboard `latest.json` version
state.
Updater install/repair and update runs remove managed legacy desktop launcher
shortcuts that use old `Revit MCP` names from local and OneDrive desktop
folders and report the result as `diagnostics.desktopLauncherCleanup`. If
launcher evidence still shows legacy references, rerun the stable update first,
then recollect launcher evidence.

For SSH-managed workstations, use the evidence-only collector instead of the
install/repair deploy script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-rollout-evidence.ps1 `
  -TargetsPath C:\ProgramData\DPE\revAgentOps\fleet.json `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
```

The collector stages only read-only evidence tools on each target, runs
source-free inventory in `dryRun`, runs desktop launcher scans, retrieves the
staged JSON evidence files back to the coordinator machine, and then
publishes the per-machine NAS evidence centrally before aggregating launcher
evidence. SSH targets do not need direct NAS write access for this evidence
path. It does not install, repair, update, stop processes, or run source-free
migration in commit mode.

Publishing may refresh reference/transport material under NAS `tools`, but no
workstation or coordinator may execute those loose scripts. Updater execution
starts from the protected ProgramData bootstrap and broker-created authenticated
snapshot; operational helpers run from a clean repo or independently protected
local coordinator copy.

## GitHub Actions Signed Source-Free CD

The protected CD workflow is `.github/workflows/signed-source-free-cd.yml`.
It runs automatically when protected `main` is updated and builds/validates the
signed release root without publishing. Manual dispatch from `main` defaults to
build/validate only. `publish_to_pilot=true` selects the isolated signed pilot;
`publish_to_nas=true` selects the separately approved stable path, and both
cannot be true. The publish job is separated behind the
`revagent-production-publish` GitHub environment.

Chosen production signing model:

This is detached RS256 signing for release JSON metadata, not Windows
Authenticode code signing. The repository and protected workflow currently
have no revAgent code-signing certificate/service, PFX-backed signing step, or
signed bootstrap EXE/MSI project. `Get-AuthenticodeSignature` checks on the
official Node MSI verify a third-party OpenJS artifact and do not provide a
clean-machine revAgent trust anchor.

- Use an office-controlled self-hosted Windows runner, normally selected with
  `["self-hosted","Windows","revagent-cd"]`.
- Keep the private release signing key as a local file on that runner, outside
  the Git checkout and outside NAS `tools\`.
- Store only public release verification keys in
  `release-trusted-keys.json`; the CD producer copies that public file into
  release `tools\config\release-trusted-keys.json` for workstation updaters.
- Production accepts exactly one pinned RS256 signing identity. The current
  key id is `revagent-prod-rsa-2026q3` and its public-key fingerprint is
  `32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33`.
  The production `release-trusted-keys.json` must contain exactly that one key;
  a live old-plus-new overlap document is rejected.
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

These are pinned production values, not examples. Key rotation is a coordinated
code-and-prestage rollout, not an in-place multi-key trust expansion:

1. Freeze production publish and generate the replacement private/public key
   material outside Git, release ZIPs, and NAS `tools`.
2. Prepare a new single-key trusted-key document and update the exact key-id and
   fingerprint pins together in the signed producer, NAS publisher, direct
   publisher, and bootstrap-prestage evidence generator. Update the protected
   runner key path/id variables in the same change window.
3. Merge through the protected PR gates, build and validate a source-free
   release signed only by the replacement key, but do not promote NAS stable.
4. Generate authenticated bootstrap-prestage evidence from that staged signed
   release. Use the two-shell procedure in `docs/BOOTSTRAP_PRESTAGE.md` to stage
   the replacement single-key trust and matching protected bootstrap on the
   developer/canary machine, then on every required online workstation. Record
   offline machines as pending; they must be prestaged before they can consume
   the replacement-key stable release.
5. Verify the protected bootstrap state and signed readiness on the staged
   machines, then explicitly publish the replacement-key release to NAS stable
   and run the normal developer/canary and online-fleet audit.
6. Retire the old private/public material only after the rollout evidence is
   complete. A rollback across a signing-key boundary requires another
   coordinated code-and-prestage operation; do not add the old key beside the
   new key or bypass the pinned identity checks.

The GitHub environments `revagent-release-signing` and
`revagent-production-publish` exist and their path/key variables are set.
Reviewer and wait-timer protection rules could not be enabled on the current
GitHub repo plan; GitHub returned billing-plan 422 errors when those protection
rules were requested. Until reviewer protection is available, the human gate is
the protected PR review/CI/merge decision for `main`; after merge, signed CD
validates automatically, and each NAS channel publish requires an explicit
manual workflow dispatch. Pilot and stable inputs are mutually exclusive.

The build job runs `scripts/invoke-signed-source-free-cd.ps1`. That wrapper
runs `scripts/test-ci.ps1`, uses `publish-nas-release.ps1` against a staging
release root, requires release signatures, copies public trusted keys into
`tools\config`, and runs `scripts/check-signed-stable-readiness.ps1`. Before
production packaging, the workflow downloads the exact official Node v24.14.1
MSI and verifies the pinned SHA-256, byte size, valid Authenticode signature,
and exact OpenJS signer. The producer then binds it into the signed manifest as
the version-owned `external\node-v24.14.1-x64.msi` sidecar.

For an explicit pilot or stable publish dispatch, the build job uploads the
validated release root as one immutable, one-day GitHub Actions artifact and
exports its exact artifact id, artifact digest, and signed source-channel
SHA-256. The publish job independently binds that artifact through the GitHub
REST response to the same repository, workflow run, and `main` commit, then
downloads it by exact artifact id with digest-mismatch failure enabled. The
download must land in a previously absent, job-unique direct child of local
`RUNNER_TEMP` with an ordinary non-reparse ancestor chain; the publisher also
requires the build-bound source-channel SHA-256. A normal `main` push still
runs signed build/validation without uploading a publish artifact. This keeps
signing and publish separated by environment and by the protected `main` merge
gate without trusting a cross-job pathname handoff.

The publish job runs
`scripts/publish-signed-source-free-release-to-nas.ps1`; it does not rebuild or
re-sign. For pilot it holds exact source/stable/tools identities, creates a new
pilot release through handle-bound create-new operations, and writes the signed
pilot pair with same-handle compare-and-swap/rollback. The canonical stable
pair, active stable release, and shared tools are immutable pilot evidence.
Stable publication creates the release tree handle-bound, exact-manages the
complete 13-file stable/tools operator surface, and promotes the signed channel
pair with same-handle compare-and-swap/rollback plus final identity checks. No
weaker direct writer or recovery path is authorized; publication remains a
separately approved manual dispatch.

The canonical `revAgent-deploy` NAS root is a writable signed transport, not an
executable trust boundary. `scripts/publish-signed-source-free-release-to-nas.ps1`
does not change remote DACLs and reports `transportTrust=signed_local_snapshot`.
Before writing, it requires the exact canonical production root, rejects
reparse links and hardlinks, creates a temporary directory whose filesystem
owner SID must equal the release-root owner SID, and proves `CreateNew` plus
delete access with a cleaned canary. The result is writer-capability evidence,
not authentication or proof of the human/process publisher identity. Signed
source readiness, positive and monotonic `releaseSequence`, exact pilot machine
policy, signature-before-channel promotion, and handle-bound rollback remain
fail-closed. Workstations execute only after the signed surface is copied into
and re-attested from a protected local ProgramData snapshot.

Windows DACL inspection is optional defense-in-depth telemetry because Samba
servers may not expose mutable Windows ACL semantics. Pass
`-IncludeAclTelemetry` to let the publisher call
`scripts/set-nas-release-acl.ps1 -Mode Preview`; without that switch it reports
`not_requested_optional`. An unsupported diagnostic is reported but does not
weaken signed transport validation. `Seal` and `Unseal` remain explicit
operator-only administration modes and are never invoked by the publisher. Do
not treat a successful ACL preview, or the absence of ACL telemetry, as
executable trust evidence.

After installation, the first executable hop is local-only:
`%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd`, which invokes
the sibling protected `Start-revAgent-Update.ps1`. When that bootstrap is current
and verified, STABLE bypasses Refresh; the protected local GUI, signed
inbox/snapshot verification, and bounded UAC machine phase of the ordinary
package update continue to operate normally. When verification says the
bootstrap itself is stale, its verifier/key may not authorize its own
replacement: the unanchored NAS Refresh path stops before UAC.

The production publisher also exact-manages
`tools\revAgent Updater STABLE.cmd` as the only clean-workstation operator
entry. It is currently a security-stop entry, not a successful O4 self-service
installer: any missing or stale protected-bootstrap state that enters NAS
Refresh returns exit 84 before UAC, prints the supervised prestage/refresh
direction, and does not elevate locally staged release content. Direct
`-ElevatedApply` is disabled by the same guard. This behavior prevents a
standard user, a stale local verifier, or caller-supplied hashes from
bootstrapping their own administrator-side trust.

Self-service bootstrap install/refresh may be re-enabled only after an
Authenticode-signed bootstrap broker, or an equivalent IT-prestaged machine
verifier and pinned production key, independently revalidates the detached
release signature after elevation. Until then, a missing or stale protected
bootstrap fails closed to the supervised manual prestage/refresh below. The
bootstrap root and state are
SYSTEM/Administrators-owned, standard-user read/execute only, link/hardlink
guarded, and checked with effective directory and file-write probes. The local
bootstrap, GUI, integrity verifier, permissions helper, and migration verifier
must also match their current signed release-manifest components exactly.
`RevAgent.Permissions.psm1` is a required protected sibling of
`RevAgent.SourceFreeMigration.psm1`; both are independently hash-bound in
`bootstrap-state.json` before the GUI imports either module.
The repository-side prestage installer must never itself be elevated. Its bytes
must first be matched to the independent evidence and copied with OS/admin-only
commands to
`%ProgramData%\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1`;
only that protected canonical copy may run. The evidence binds both the staged
installer (`localBootstrapInstallerScript`) and its imported module.
The exact two-shell procedure is `docs/BOOTSTRAP_PRESTAGE.md`. Its unelevated
producer opens the pinned distribution-integrity verifier without write/delete
sharing, hashes the exact acquired bytes, and executes those bytes as an
in-memory module; it never imports the pathname after the hash check. The
producer then verifies the signed release and emits schema-versioned evidence;
the fresh elevated shell stages those bytes with built-in OS APIs and exact ACLs.
The elevated consumer must never derive replacement evidence.
When the server supports Windows ACL telemetry, inspect it without mutation
with:

```powershell
.\scripts\set-nas-release-acl.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy" `
  -Mode Preview
```

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
payloads, run `migrate-source-free-install.ps1 -Mode dryRun` first. The
standalone tool is inventory-only; its retained `-Mode commit` compatibility
value fails closed without launching an updater or requesting elevation. Start
`C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd` and choose
`Migrate` in the protected GUI. If the installed updater is missing or too old,
use the GUI `Install/Repair` path, which bootstraps the current signed updater
before running migration. Only this GUI path owns the authenticated release
inbox, privileged snapshot broker, administrator-only machine phase, and
original unelevated user continuation required for a mutating migration.

The brokered migration disables unchanged-payload skips, refreshes runtime/docs
and, unless policy preserves local instructions, Codex instruction integration,
then cleans managed source/developer artifacts from package/runtime/Codex
skill/updater backup locations. It must not delete Codex sessions, memory,
Revit models, or user project folders.

For a mixed-generation or damaged workstation, use the same protected GUI's
`Install/Repair` action as the canonical rebaseline. This is intentionally more
complete than an ordinary version update: after signed snapshot verification it
replaces the managed package/runtime/updater payloads, removes only allowlisted
retired `RevitMCP` machine and per-user surfaces, and then rebuilds the current
user integration. The exact cleanup contract preserves current revAgent state,
spatial data, telemetry, add-ons and logs, unknown legacy-root children, and
custom/real Codex skill directories. Unsafe reparse topology, an unexpected
item type, incomplete inventory, or an exact managed legacy surface that cannot
be removed is a failed/action-required rebaseline, not a warning-only success.
Because exact Revit add-in surfaces participate in this cleanup, Revit must be
closed even when the signed package's current add-in hashes are otherwise
unchanged.
When `codexInstructionPolicy=preserve-local`, migration does not traverse or
replace current Codex instruction roots. The only instruction-side legacy
exception is the exact `.codex\skills\revit-mcp` leaf when it is a reparse
point to the retired machine skill root; the current `revAgent` skill,
`AGENTS.md`, configuration, sessions, and memory are preserved. Package,
runtime, updater, and backup cleanup still applies.

All shipped updater tools are mandatory during this rebaseline. Tool files are
atomically replaced and length/SHA-256 verified; `lib` and `config` are staged,
verified, and swapped as complete trees. A missing source, stale optional
destination, reparse point, non-unit hardlink, or conflicting write/delete
handle is a fail-closed result. The installer also protects the canonical
Revit `Addins` parent, exact year root, and `revAgent.addin` manifest with
SYSTEM/Administrators FullControl and Users ReadAndExecute, without recursively
rewriting unrelated vendor add-in children.

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
release-manifest fixtures. The local artifact producer writes
`manifest.sig.json` and the selected channel signature when
`-SigningPrivateKeyPath` and `-SigningKeyId` are provided; private keys must
stay outside the repo, staging output, and NAS tools. The updater imports the
local helper before caching a package. Trusted
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
scheduled audit has no rollback or install authority and does not pass that
flag.

License/seat verification is optional and disabled by default. The updater can
load a signed `revagent-license.json` plus `revagent-license.sig.json` from the
configured license path, and public license verification keys from updater
config or `config/license-trusted-keys.json`. `audit` policy records missing,
expired, or tampered license evidence without blocking; `enforce` blocks before
package replacement. License private keys must stay outside the repo, package,
NAS tools, updater config, and workstation install.

Large offline dependency payloads are signed release sidecars, not Git or ZIP
assets:

```text
releases\<version>\external\node-v24.14.1-x64.msi
```

Signed CD supplies the producer with a separately downloaded, pinned official
asset. `publish-nas-release.ps1` performs a deny-write/delete, single-hardlink,
create-new copy into the versioned release, and the signed manifest records its
exact path, SHA-256, size, signer, and signature status. A legacy-compatible
copy may also exist in the local CD artifact's `tools\dependencies`, but pilot
publication never copies or mutates shared NAS `tools`; the updater trusts only
the manifest-bound versioned sidecar. Repeated generation into the same local CD
root reuses that compatibility copy only when its path, single-link identity,
size, hash, and production Authenticode signer still match; otherwise generation
fails without deleting or replacing the existing file. A future stable publish
remains a separate approval boundary. During this one-time contract transition, the NAS publisher
may authenticate an exact canonical already-active STABLE or pilot destination
baseline that predates the sidecar. That allowance never applies to a source,
candidate, noncanonical channel path, or full-root readiness scan.

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

Stable workstation launcher:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

The four legacy `.cmd` aliases retained for compatibility are published only as
exact-managed stubs in the production NAS root and `tools` tree; they delegate
to the canonical STABLE entries. The protected local launcher is hash-bound in
`bootstrap-state.json` and in the signed release manifest; the NAS channel is
verified data, not executable trust.

After the protected bootstrap is current and verified, the GUI installs or
refreshes the local updater and then runs an initial update.
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
scheduled audit, or install/repair. `latest.json` is dashboard-ready: it
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

The preferred updater registration is a per-user Scheduled Task. It runs
`update-from-nas.ps1 -AuditOnly` once per day at 12:00 local time. If task
registration is blocked, the Startup fallback follows the same audit-only
schedule. Neither path installs dependencies or replaces payloads. New installs
remove legacy `Revit MCP Auto Update.cmd` / `.vbs` fallbacks; manual update and
install/repair remain available from the GUI and command launchers.

### Split-Privilege Workstation Contract

The GUI starts unelevated and captures the interactive account, SID, profile,
and effective `CODEX_HOME`. It validates bootstrap paths against the canonical
read-only `revAgent-deploy\tools`, `channels`, and selected signed `releases`
roots. It then launches only the bounded machine phase through UAC. That phase
must receive the captured user identity, run elevated, and never execute a
binary from `%LOCALAPPDATA%`, `%APPDATA%`, npm shims, or another user-writable
path. After it exits, the original GUI process runs `-UserPhaseOnly` without
elevation. A different credential-provider identity, SID, or profile fails
closed instead of redirecting integration into an administrator profile.

`-NoProfile` does not disable PowerShell module auto-loading. Every phase
therefore replaces inherited `PSModulePath` with canonical PSHOME/System32/
Program Files roots and imports security, management, archive, CIM, and task
modules by exact protected manifests before any trust probe. The elevated phase
also replaces inherited `TEMP`/`TMP` with a new administrator/SYSTEM-only
directory below canonical Windows Temp before importing modules that compile or
load native helpers.

The machine install root is administrator-owned. Standard users receive
read/execute access to code, `package`, `runtime`, updater scripts/libraries and
config, Revit payload, and the machine Codex source. Their write access is
limited to updater `logs`, `user-state`, the product data `state` root, and
declared add-on state roots. Never make an executable/config tree writable just
to support the scheduled audit or user integration.

The unelevated integration resolves an explicit target `CODEX_HOME`, then the
target user's environment override, then `%USERPROFILE%\.codex`. Codex CLI and
Node candidates are classified by origin, Authenticode signer, version, and
capabilities; the persisted Node command must be a signed system runtime under
Program Files. Config mutation uses an exclusive lock, expected SHA-256, and a
same-directory atomic replace while retaining idempotent `service_tier =
"fast"`, `[features]`, and `[memories]` normalization. Registration is accepted
only after `codex mcp get <name> --json` matches and both servers answer MCP
`initialize` plus `tools/list`.

Codex execution is Store-bound on Windows. AppX inventory must complete
successfully and return exactly one current `OpenAI.Codex` package. Its exact
family, publisher, Store status, WindowsApps location, manifest, signed block
map, and `app\resources\codex.exe` content must all attest. The elevated machine
phase copies that verified binary, without executing it, to the deterministic
administrator-protected path
`<InstallRoot>\codex\cli\store\<PackageFullName>\<SHA256>\codex.exe`. The
unelevated user phase independently re-attests the current Store package and
executes only that exact protected copy. A `%LOCALAPPDATA%` mirror may be
reported as diagnostics, but it is never an executable origin. Query/access
errors, zero packages, multiple packages, and any invalid package fail closed;
none is treated as permission to try another CLI.

The desktop task/model contract and the CLI config contract are probed
independently: GPT-5.6 desktop tasks may use the user-facing `Ultra` effort even
when a particular CLI rejects literal root-level
`model_reasoning_effort = "ultra"` in `config.toml`. The selected protected CLI
is first tested with that value in an isolated disposable `CODEX_HOME`. If it
accepts it, the real root value is preserved. Only when that exact CLI rejects
`ultra` but accepts `xhigh` is the root value migrated to `"xhigh"` inside the
same locked compare-and-swap update. Profile/table-local values and unrelated
operator settings remain unchanged. The protected CLI is then probed against
the real `CODEX_HOME`; a rejection fails closed instead of falling back to
direct config editing or a mutable executable. Desktop task-level `Ultra`
selection is verified separately in the new-task pilot.

The Windows standalone installer currently leaves no authenticated persistent
receipt or signed full-file hash chain that revAgent can bind after install.
Consequently user-writable standalone layouts, legacy
`%LOCALAPPDATA%\OpenAI\Codex`, custom `CODEX_INSTALL_DIR`, npm shims, arbitrary
Program Files paths, and copied signed binaries remain non-executable even when
their directory names and local JSON look plausible. The supported recovery is
to install/repair the Store-backed ChatGPT desktop package.

Attestation and process creation are one guarded operation. The implementation
opens the executable plus every directory from its attestation root with write,
delete, and rename sharing denied; it verifies handle identity, pathname
identity, link count, SHA-256, signer, package binding, and protected ACL where
required while those handles remain open. It then creates the process suspended,
assigns it to the kill-on-close Job Object, sets the current directory to the
exact protected executable directory, and resumes the primary thread only after
assignment succeeds. Version/capability probes, final `mcp get` readback, and
the protected Node/MCP-server handshake all use this primitive, so neither the
protected executable nor a parent directory can be swapped and no early child
can escape before Job assignment. Timeout/error cleanup terminates and waits
for the complete process tree before releasing those guards.

`managed-user-pack` copies the managed skill to the canonical
`%USERPROFILE%\.agents\skills\revAgent` path and removes only hash-verified
managed `.codex\skills` duplicates. User-root reparse components and unexpected
hardlinks fail closed. `preserve-local` performs no instruction replacement;
it reports `present`, `loaded`, safe path, and SHA-256 for skill and AGENTS
surfaces while MCP/config work continues.
It also writes a managed revAgent UTF-8 block to both Windows PowerShell and
PowerShell 7 user profile files, and sets the current user's default console
code page to UTF-8. This keeps Turkish text in `AGENTS.md`, `SKILL.md`, and
MCP/Revit output readable in Codex PowerShell terminals. Installer, updater,
updater-task installer, and migration entrypoints also set UTF-8 in the current
process before writing transcript/log output, because scheduled or remote
automation commonly launches PowerShell with `-NoProfile`.
ChatGPT may be open or closed during the two-phase update, but an already-open
task can retain stale MCP/skill descriptors. Acceptance must open a genuinely
new ChatGPT task after user integration (restart ChatGPT if the new task still
shows stale state) and verify revAgent MCP, AGENTS, and the expected managed or
preserve-local skill attestation.

Security/compatibility acceptance for updater changes includes:

- unsigned/malicious Codex and Node candidates are not executed;
- AppX inventory errors and Store absence fail closed, while planted
  standalone/custom/copied-signed layouts remain rejected;
- a malicious app-local DLL beside a user mirror is never loaded because only
  the administrator-protected Store-derived copy is executable;
- deterministic held-handle fixtures prove both executable and parent-directory
  rename/swap attempts fail before Codex process creation;
- config, skill, AGENTS, and legacy-cleanup reparse/hardlink fixtures fail
  closed without touching the target behind the link;
- default and explicit `CODEX_HOME` work, while a different UAC/current-user SID
  cannot receive the original user's integration;
- ChatGPT-open and ChatGPT-closed runs complete, followed by new-task uptake;
- early-child and timeout/error fixtures prove Job assignment precedes resume
  and the complete child process tree terminates before executable and
  parent-directory guards are released;
- config compare-and-swap rejects a changed expected hash, `mcp get` matches
  both commands/arguments, and both `initialize`/`tools/list` handshakes pass.

Deliver this risk path through the normal draft PR, protected engineering and
review gates, merge, and automatic signed source-free build. Dispatch only the
signed `publish_to_pilot=true` channel for DESKTOP-OKNV128 and NET01, then
verify exact version/hash, ACLs, both phase reports, Revit behavior where
applicable, and a genuinely new ChatGPT task. This is sufficient to close the
pilot task. General stable/fleet publication remains a later, separately
approved `publish_to_nas=true` action; do not contact other machines.

Background updater notifications:

- `deferred-revit-close-required`: user must save/sync, close Revit, and rerun
  the updater because Revit-loaded payload files changed.
- audit notifications report `update-available`, current, or guarded status;
  they do not report a background payload install.
- Notifications are throttled per version/status; default throttle is 240
  minutes.
- For supervised rollouts where the normal notification path is unsuitable for
  remote execution, use
  `docs/REVAGENT_NO_NOTIFICATION_UPDATE_RUNBOOK.md`. This is a runbook-only
  path, not deploy approval and not a separate installed updater launcher.

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
powershell -ExecutionPolicy Bypass -File ".\installer\install-self-contained.ps1" `
  -RevitVersion 2022 `
  -Uninstall `
  -SkipCodexUserIntegration `
  -SkipUserProfileCleanup `
  -SkipLegacyCleanup
```

Elevated machine-only uninstall also requires `-SkipCodexUserIntegration`,
`-SkipUserProfileCleanup`, and `-SkipLegacyCleanup`. Remove user Codex
instructions only through a separate, explicit unelevated cleanup workflow.

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
