# Fast, Quality-Preserving Nightly PR Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the per-change PR loop from a felt ~15 min down to ~4 min wall-clock, fully autonomous (no human merge click), without weakening any test or review gate.

**Architecture:** Keep every quality gate, but run each gate *once, at the right moment*. Tests (`Engineering gates`, ~2 min) stay on every push as fast inner-loop feedback. The Claude review (the real ~6–10 min cost) moves from "every push at `xhigh`" to "**once** when the PR is marked ready, at risk-tiered effort", and becomes a **deterministic merge gate** via `--json-schema` structured output. GitHub auto-merge then closes the loop on `tests + review` both green — no human in the per-change path.

**Tech Stack:** GitHub Actions (self-hosted Windows runner, label `revagent-cd`), `anthropics/claude-code-action@v1`, GitHub branch protection + auto-merge, PowerShell gate scripts, `gh` CLI.

> **Implementation note (2026-06-28):** Phase 1 was implemented with three
> corrections to the snippets below, after verifying the `claude-code-action@v1`
> contract against its `action.yml`. The shipped `claude-review.yml` is the source
> of truth; prefer it over the raw snippets here.
> 1. **`conclusion` output does not exist.** The action exposes only
>    `execution_file`, `branch_name`, `github_token`, `structured_output`,
>    `session_id`. The verdict step uses the step-status context
>    `steps.review.outcome`, not `steps.review.outputs.conclusion` (which is
>    always empty → would have made the gate permanently RED and deadlocked merges
>    once required).
> 2. **No PowerShell here-string injection.** `structured_output` is model-authored
>    and was being interpolated into the script body; a verdict line equal to `'@`
>    could terminate the here-string and execute arbitrary PowerShell. It is now
>    passed via `env:` (`REVIEW_OUT`) and read as data.
> 3. **Final-message reliability.** The prompt now makes "final message = bare JSON
>    only" dominant so `structured_output` is reliably populated; the human-readable
>    tally stays in the `gh pr comment`.
>
> Phase 2 (live repo settings: `allow_auto_merge`, required-check context) is
> sequenced **after** this workflow is merged to `main` and proven on one normal
> (non-workflow) PR — see the self-edit-skip note in Phase 1 / Validation.

---

## Measured baseline (why this plan targets what it targets)

All numbers are from real runs on this repo (`gh run list`, 2026-06-28):

| Stage | Trigger today | Measured | In the per-change loop? |
|---|---|---|---|
| **CI `Engineering gates`** | every push (PR + main) | **~115–130 s** | yes — but already fast |
| **Claude review (Opus 4.8 `xhigh`)** | **every push** (`synchronize`) | **~360–631 s (6–10.5 min)** | yes — **dominant cost** |
| **CD `signed-source-free-cd`** | push to main (build+validate only; NAS publish is manual `workflow_dispatch`) | ~256 s | **no** — runs post-merge, non-blocking |

Decisive facts discovered in the repo (these overturn the earlier "C# msbuild is the bottleneck" assumption):

- **CI compiles no C#.** `scripts/test-ci.ps1` runs only: `npm ci` + `tsc --strict` for 2 TS packages, ~9 PowerShell policy/integrity scripts, and `npm test` per package. The Revit C# plugin ships as **committed binaries**; `scripts/build-revit-plugin.ps1` / msbuild are **not** invoked by `test-ci.ps1` or `test-all.ps1`. So two-language parallel jobs / NuGet / msbuild caching give ~0 benefit to the PR loop.
- **The review is not a gate today.** `claude-review.yml` posts comments and **exits success regardless of findings** — branch protection cannot currently block on it.
- **Branch protection on `main`:** required check = `Engineering gates` only; `strict` (up-to-date) = on; `enforce_admins` = on; required reviews = 0.
- **Repo `allow_auto_merge` = false.** PRs are created **non-draft** (so review fires on every dev push).
- **No `CSI`/`OAPI`/structural module exists in this repo** — that risk path is future; risk tiering below covers the paths that *do* exist (C# plugin, installer, signing/publish, signing CD).

**User decisions driving this plan:**
1. **Merge gate = tests + Claude review** (review must pass before auto-merge).
2. **Review = one review at PR-ready, risk-tiered effort** (`high` default, `xhigh` auto on risk paths).

---

## Target loop (after this plan)

```
AI opens DRAFT PR ──push,push,push──▶ only "Engineering gates" (~2 min) runs each push  (fast self-correction, NO review)
        │
        └─ AI: gh pr ready  +  gh pr merge --auto --squash
                 │
                 ▼
        Claude review runs ONCE  (effort = high, or xhigh if risk paths touched)  ~3–4 min (high) / ~7–10 min (xhigh)
                 │
        ┌────────┴─────────┐
     CLEAN/nits         BLOCKING
   (green check)       (red check)
        │                  │
   auto-merge fires    PR holds; AI fixes, re-triggers review (gh pr ready --undo && gh pr ready)
   when gates+review              └── you read it in the morning if still red
   both green
```

Wall-clock to merged for a clean PR ≈ `max(CI 2 min, review ~3–4 min)` ≈ **~4 min, no human click**. During development only the 2-min CI runs.

---

## File / change map

| Path | Action | Responsibility |
|---|---|---|
| `.github/workflows/claude-review.yml` | Modify | one-review trigger, effort tiering, structured-output verdict gate, stable job name |
| Repo settings (`gh api`) | Modify | enable `allow_auto_merge` |
| Branch protection (`gh api`) | Modify | add review check context to required checks |
| `docs/DEVELOPER_RUNBOOK.md` | Modify | document the draft→ready→auto-merge nightly convention |
| `AGENTS.md` | Modify | short pointer so the nightly Codex/Claude agent follows the convention |
| `.github/workflows/ci.yml` | Modify (Phase 4, OPTIONAL) | optional docs-only path handling — see gotcha |

---

## Phase 1 — Single risk-tiered review that actually gates (highest ROI)

This phase delivers ~90% of the win: kills the repeated 6–10 min reviews and makes the one remaining review a real, fast, deterministic gate.

### Task 1.1: Stop reviewing every push; review once at ready

**Files:** Modify `.github/workflows/claude-review.yml:10-16`

- [ ] **Step 1: Change triggers — drop `synchronize`, add stable job name**

Replace the `on:` block and add a `name:` to the job so its check context is stable and requireable:

```yaml
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
```

And in the job (`.github/workflows/claude-review.yml:24`) add a name:

```yaml
jobs:
  review:
    name: Claude review gate
    if: ${{ github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: [self-hosted, Windows, revagent-cd]
```

Rationale: the existing `if` already skips draft PRs, so a draft that receives pushes never triggers a review. Dropping `synchronize` ensures that even a non-draft, already-ready PR is not re-reviewed on every follow-up push. Re-review is requested explicitly (Task 1.4).

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/claude-review.yml
git commit -m "ci(review): review once at PR-ready instead of every push"
```

### Task 1.2: Risk-tiered effort (`high` default, `xhigh` on risk paths)

**Files:** Modify `.github/workflows/claude-review.yml` (add a step before the Claude step; change `--effort`)

- [ ] **Step 1: Add an effort-tier step** (insert after "Resolve Claude Code executable", before "Claude PR review")

```yaml
      - name: Determine review effort tier
        id: tier
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"
          $baseRef = "${{ github.event.pull_request.base.ref }}"
          git fetch --no-tags origin $baseRef | Out-Null
          $changed = @(git diff --name-only "origin/$baseRef...HEAD")
          # Paths where a miss is expensive: C# Revit plugin, installer, signing/publish, signing CD.
          # (Add a structural/CSI-OAPI glob here when that module lands.)
          $riskGlobs = @(
            '^src/revit-plugin/',
            '^installer/',
            '^scripts/.*sign',
            '^scripts/publish',
            '^scripts/.*nas',
            '^scripts/invoke-signed',
            '^\.github/workflows/signed-source-free-cd\.yml$'
          )
          $effort = 'high'
          foreach ($f in $changed) {
            foreach ($g in $riskGlobs) {
              if ($f -match $g) { $effort = 'xhigh'; break }
            }
            if ($effort -eq 'xhigh') { break }
          }
          "effort=$effort" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
          Write-Host "Review effort tier: $effort (changed files: $($changed.Count))"
```

- [ ] **Step 2: Use the dynamic effort** — change `.github/workflows/claude-review.yml:125`

```yaml
            --model claude-opus-4-8
            --effort ${{ steps.tier.outputs.effort }}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/claude-review.yml
git commit -m "ci(review): risk-tiered review effort (high default, xhigh on risk paths)"
```

### Task 1.3: Make the review a deterministic merge gate (structured-output verdict)

**Files:** Modify `.github/workflows/claude-review.yml` (Claude step: add `id`, `--json-schema`, prompt addendum; add a verdict-enforcement step)

- [ ] **Step 1: Give the Claude step an id and a JSON-schema verdict** — edit the `Claude PR review` step

Add `id: review` to the step, and append to `claude_args`:

```yaml
      - name: Claude PR review
        id: review
        uses: anthropics/claude-code-action@v1
        with:
          ...
          claude_args: |
            --model claude-opus-4-8
            --effort ${{ steps.tier.outputs.effort }}
            --json-schema '{"type":"object","properties":{"blocking":{"type":"boolean"},"tally":{"type":"string"}},"required":["blocking","tally"]}'
            --allowedTools "Read,Grep,Glob,LS,mcp__github_inline_comment__create_inline_comment,Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr comment:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*),Bash(git diff:*),Bash(git grep:*),Bash(rg:*),Bash(grep:*),Bash(find:*),Bash(cat:*),Bash(ls:*),Bash(head:*),Bash(tail:*),Bash(wc:*)"
            --disallowedTools "Edit,Write,MultiEdit,Bash(git push:*),Bash(git commit:*),Bash(git add:*),Bash(rm:*)"
```

- [ ] **Step 2: Append a verdict instruction to the existing prompt** (after the current "Output" section, keep all existing comment instructions):

```
            FINAL OUTPUT (required): after posting comments, your final message must be
            ONLY the JSON object matching the provided schema:
            - blocking = true  -> you posted at least one "important:" issue that must be
              fixed before merge.
            - blocking = false -> clean, or only "nit:" comments.
            - tally = the same one-line tally string you used in the top-level comment
              (or "No blocking issues found.").
```

- [ ] **Step 3: Add a verdict-enforcement step** (after the Claude step). This makes the job (and thus the `Claude review gate` check) RED when blocking issues exist:

```yaml
      - name: Enforce review verdict
        if: ${{ always() }}
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"
          $conclusion = "${{ steps.review.outputs.conclusion }}"
          if ($conclusion -ne "success") {
            throw "Claude review did not complete successfully (conclusion=$conclusion); blocking merge."
          }
          $out = @'
          ${{ steps.review.outputs.structured_output }}
          '@
          if ([string]::IsNullOrWhiteSpace($out)) {
            throw "Claude review produced no structured verdict; blocking merge (fail closed)."
          }
          $verdict = $out | ConvertFrom-Json
          if ($verdict.blocking) {
            throw "Claude review found blocking issue(s): $($verdict.tally)"
          }
          Write-Host "Claude review verdict: non-blocking ($($verdict.tally))." -ForegroundColor Green
```

Design note — **fail closed**: if the review errors or returns no verdict, the check is RED and the PR will not auto-merge. This preserves the quality red line (no silent pass).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/claude-review.yml
git commit -m "ci(review): gate merge on structured review verdict (fail-closed)"
```

### Task 1.4: Re-review mechanism (for the autonomous fix loop)

No code change — convention only (documented in Phase 3). Because `synchronize` no longer triggers review, after the AI pushes a fix in response to a blocking review it re-requests a single review by toggling ready state:

```bash
gh pr ready <num> --undo   # -> draft (no review)
gh pr ready <num>          # -> ready_for_review fires -> exactly one fresh review
```

- [ ] **Step 1: Verify Phase 1 end-to-end on a throwaway PR** (see Validation section). Do not proceed to Phase 2 until a draft PR produces (a) zero reviews while draft, (b) exactly one review at ready, (c) a RED check on an intentionally-bad diff and GREEN on a clean diff.

---

## Phase 2 — Auto-merge on `tests + review` (removes the human merge click)

### Task 2.1: Enable repository auto-merge

**Files:** repo settings via `gh api`

- [ ] **Step 1: Turn on auto-merge**

```bash
gh api -X PATCH repos/BTankut/revit-mcp-skill -F allow_auto_merge=true
```

- [ ] **Step 2: Verify**

```bash
gh api repos/BTankut/revit-mcp-skill --jq '.allow_auto_merge'
# Expected: true
```

### Task 2.2: Add the review check to branch protection (required: tests + review)

**Files:** branch protection via `gh api`. Do this **after** the `Claude review gate` check has run at least once (Phase 1 validation), so the context name is registered.

- [ ] **Step 1: Confirm the exact review check context name**

```bash
# After one review run on a test PR:
gh api "repos/BTankut/revit-mcp-skill/commits/<test-pr-head-sha>/check-runs" --jq '.check_runs[].name'
# Expect to see: "Claude review gate"  (and "Engineering gates")
```

- [ ] **Step 2: Set required checks to both, keep strict**

```bash
gh api -X PATCH repos/BTankut/revit-mcp-skill/branches/main/protection/required_status_checks \
  -F strict=true \
  -f 'contexts[]=Engineering gates' \
  -f 'contexts[]=Claude review gate'
```

- [ ] **Step 3: Verify**

```bash
gh api repos/BTankut/revit-mcp-skill/branches/main/protection/required_status_checks --jq '.contexts'
# Expected: ["Engineering gates","Claude review gate"]
```

Note: `enforce_admins` is on — admins are also held to these checks (intended). The review check is now required, so a RED verdict (blocking) prevents merge until resolved.

### Task 2.3: Arm auto-merge per PR (agent convention)

No workflow change — the nightly agent runs, after marking ready:

```bash
gh pr merge <num> --auto --squash
```

Auto-merge completes the PR automatically once `Engineering gates` **and** `Claude review gate` are green and the branch is up to date with `main`.

- [ ] **Step 1: Validate** with the test PR from Phase 1: arm auto-merge on a clean PR and confirm it merges with no human click after both checks pass.

---

## Phase 3 — Document the nightly convention (so the autonomous agent follows it)

The speedups depend on the AI agent creating **draft** PRs and arming auto-merge. Encode this where the nightly Codex/Claude agent reads instructions.

### Task 3.1: Add the workflow to the developer runbook

**Files:** Modify `docs/DEVELOPER_RUNBOOK.md` (append a section)

- [ ] **Step 1: Add section "Nightly autonomous PR loop"** with this content:

```markdown
## Nightly autonomous PR loop

1. Branch, then open the PR as a DRAFT:  `gh pr create --draft --fill`
2. Iterate freely. Each push runs only `Engineering gates` (~2 min) — fast feedback.
   No Claude review runs while the PR is a draft.
3. When the work is complete and `Engineering gates` is green:
   - `gh pr ready <num>`            # triggers exactly one Claude review
   - `gh pr merge <num> --auto --squash`
4. Review effort is automatic: `high` by default, `xhigh` when the diff touches
   risk paths (`src/revit-plugin/**`, `installer/**`, signing/publish/NAS scripts,
   `signed-source-free-cd.yml`).
5. If the review check is RED (blocking issue): push a fix, then re-request one review:
   `gh pr ready <num> --undo && gh pr ready <num>`
6. Auto-merge completes once `Engineering gates` + `Claude review gate` are both green.
   No human click required; read review comments in the morning.
```

- [ ] **Step 2: Add a one-line pointer in `AGENTS.md`** near its top-level workflow guidance:

```markdown
- Dev process: open PRs as draft, mark ready when done, arm `gh pr merge --auto --squash`.
  See docs/DEVELOPER_RUNBOOK.md "Nightly autonomous PR loop".
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEVELOPER_RUNBOOK.md AGENTS.md
git commit -m "docs: document draft->ready->auto-merge nightly PR loop"
```

---

## Phase 4 — OPTIONAL CI micro-optimizations (low ROI; CI is already ~2 min)

Include only if you want marginal gains. Listed with honest caveats.

### Task 4.1 (OPTIONAL): Skip the full gate for pure-docs PRs — with the required-check shim

**Caveat / gotcha:** `Engineering gates` is a *required* check. If you simply `paths-ignore` it, a docs-only PR never reports the check, and branch protection treats a missing required check as **pending → blocks merge forever**. To path-filter a required check you must add a tiny shim job that reports the **same check name** as success on skipped paths. This is real complexity for ~2 min of savings. Recommendation: **skip this** unless docs-only PRs become frequent and annoying.

If pursued: split `ci.yml` into a real `Engineering gates` job gated on `paths:` (code) and a shim job with `name: Engineering gates` gated on the complement that just `exit 0`s — so the required context always reports.

### Task 4.2 (OPTIONAL): Note on `strict` up-to-date

`strict: true` forces a PR to be up to date with `main` before merge; when `main` moves, the branch is auto-updated and checks re-run. For one-PR-at-a-time nightly work this is harmless. If you start running several PRs in parallel overnight, `strict` will serialize them (each re-runs CI after each merge). Only then consider `strict: false` — but that trades away the "tested against latest main" guarantee, so keep it **on** by default.

---

## Validation (run before declaring done)

End-to-end on a disposable test branch/PR:

- [ ] **V1 — no review while draft:** open a draft PR, push twice. Confirm `Engineering gates` ran each push and `Claude review gate` ran **zero** times.
- [ ] **V2 — one review at ready:** `gh pr ready`. Confirm exactly **one** `Claude review gate` run.
- [ ] **V3 — effort tiering:** a docs/TS-only diff logs `Review effort tier: high`; a diff touching `installer/**` or `src/revit-plugin/**` logs `xhigh`. Check the "Determine review effort tier" step log.
- [ ] **V4 — blocking gate (fail closed):** push a diff with an obvious blocking bug. Confirm the `Claude review gate` check goes **RED** and the PR does **not** auto-merge.
- [ ] **V5 — clean gate + auto-merge:** clean PR with auto-merge armed → both checks green → PR merges with **no** human click.
- [ ] **V6 — re-review loop:** on a RED PR, push a fix, `gh pr ready --undo && gh pr ready` → exactly one fresh review → green → merges.
- [ ] **V7 — branch protection intact:** `gh api .../branches/main/protection/required_status_checks --jq '.contexts'` returns both contexts; a PR with a RED review cannot be merged manually either.

---

## Quality red line — why nothing here lowers quality

- **Tests:** `Engineering gates` still runs on **every push** and is **required** for every merge. Unchanged.
- **Review coverage:** still reviewed before merge — now on the **final** state (not noisy intermediate pushes), and a real **gate** (was advisory-only before this plan).
- **Risk paths:** automatically reviewed at `xhigh`; only low-risk diffs drop to `high`. The only quality knob touched (`high` vs `xhigh`) is bounded by risk tiering and is your chosen trade-off.
- **Fail-closed:** any review error / missing verdict blocks merge. Auto-merge never bypasses a gate; it only removes the human *click* once gates pass.

---

## Rollback

Each phase is independent and reversible:
- Phase 1: `git revert` the `claude-review.yml` commits → back to per-push `xhigh` advisory review.
- Phase 2: `gh api -X PATCH .../required_status_checks -f 'contexts[]=Engineering gates'` (drop review context); `gh api -X PATCH repos/... -F allow_auto_merge=false`.
- Phase 3: revert docs commit.
