# revAgent usage-evidence action protocol

This protocol turns the 2026-06-29 to 2026-07-05 usage-intelligence findings
into product execution work. It is binding for the current send-code follow-up
sequence unless a later note explicitly replaces it.

## Evidence Boundary

- Source evidence:
  `docs/REVAGENT_USAGE_INTELLIGENCE_SEND_CODE_BACKLOG_2026-06-29_TO_2026-07-05.md`
- Product-policy split:
  `docs/REVAGENT_SCHEDULE_VISUAL_STRUCTURE_POLICY_PLAN.md`
- Release carrying the classifier and analysis contract:
  `2026.07.07.514-0c217fb3`
- Source range: 2026-06-29 through 2026-07-05 UTC.
- Factual daily send-code volume: 437.
- Session-correlated dynamic-code evidence: 606, used only for intent linkage
  because it can overlap across Codex windows.

The weekly evidence does not justify a broad claim that Codex mostly ignored
existing tools. It shows a small existing-tool problem and a much larger
capability/policy backlog.

## Decision Rules

Use these labels before opening product work:

| Label | Product decision |
| --- | --- |
| `routing_miss` | Fix routing text, tool descriptions, examples, or training. Do not add a new native tool. |
| `tool_tuning_gap` | Tune an existing tool or add a thin adapter around existing output. Avoid new Revit-side behavior unless the adapter cannot cover the use case. |
| `capability_gap` | Eligible for product work only when the pattern is repeated, general, and parameterizable. Do not create one tool per user request. |
| `policy_gap` | Write the product policy first. Do not implement model or workbook mutation until the policy is explicit. |
| `accepted_escape_hatch` | Keep as raw-code fallback evidence. Do not promote unless it becomes a repeated general capability. |

Promotion threshold:

1. The work must be repeated across sessions or users, or have high safety value.
2. It must be expressible as a general workflow with bounded context cost.
3. It must have an exact scope model, default dry-run behavior for writes, and
   deterministic verification.
4. It must not duplicate an existing native tool that can be tuned instead.

## PR Execution Protocol

Each workstream is its own PR unless a shared contract requires a combined
change. The execution order is:

1. Create a topic branch from clean `main`.
2. Make the smallest coherent change for the active workstream.
3. Run targeted local tests.
4. Open the PR as draft.
5. Push fixes until local tests and `Engineering gates` are green.
6. Mark ready with `gh pr ready` to trigger the single Claude review gate.
7. Address actionable review comments with code or docs changes. Do not mute
   or bypass blocking feedback.
8. Enable auto-merge with squash once required gates are green.
9. After merge, pull `main --ff-only` and start the next workstream.

No NAS publish or deploy is allowed during the workstream PR sequence. Deploy
waits for explicit human approval after all planned PRs are merged.

## Workstream Order

### S0: Protocol note

Status: complete in PR #205.

Goal: bind the execution protocol and convert the weekly evidence into a
sequenced product plan.

Exit criteria:

- This protocol is merged to `main`.
- Later PR descriptions reference this protocol when they implement a
  usage-derived workstream.

### S1: Existing-tool routing and tuning

Status: complete in PR #206.

Evidence:

- 3 `routing_miss` calls.
- 2 `tool_tuning_gap` calls.
- Subtypes include `schedule_cell_write_tool_available`,
  `manual_transaction_existing_write_tool_available`, and
  `safe_guard_false_positive_review`.

Scope:

- Improve assistant-facing descriptions and examples for
  `set_schedule_cells`, `set_schedule_cells_by_text`, `inspect_schedules`, and
  `inspect_sheet_text`.
- Make schedule-cell text writes clearly route to existing write tools.
- Make schedule read/export needs route to existing read tools first.
- Add or improve a local TSV/CSV output adapter only if the existing read
  output shape is the real friction.

Non-goals:

- No new Revit-side schedule write tool.
- No schedule visual formatting implementation.

Likely gates:

- Runtime MCP server tests affected by tool descriptions or adapters.
- Installer smoke assertions if product-facing tool guidance changes.
- `scripts/test-ci.ps1` before PR ready.

### S2: Classifier and manual triage for unclassified writes

Status: complete in PR #207.

Evidence:

- 168 low-confidence `unclassified_write_pattern` calls.

Scope:

- Add a deterministic review helper or classifier refinement that separates
  true Revit DB mutation from local object creation, read adapters, and
  ambiguous helper snippets.
- Keep the output review-first. It may propose candidate buckets, but it must
  not auto-promote native tools.

Non-goals:

- No product tool from the unclassified bucket without manual review evidence.

Likely gates:

- Usage-intelligence tests.
- Golden examples for true write, read-only/local object creation, and
  ambiguous cases.

### S3: Schedule visual structure design spike

Status: complete in PR #208.

Evidence:

- 160 `schedule_visual_structure` calls.
- 45 candidate rows.

Scope:

- Convert the existing policy plan into an implementation-ready contract.
- If code is added, keep it as the smallest dry-run/read-back prototype or
  internal adapter. It must require exact schedule/sheet scope.
- Preserve existing text-write routing to `set_schedule_cells` and
  `set_schedule_cells_by_text`.

Non-goals:

- No one-off tool per schedule or project.
- No implicit model save.
- No PDF or print settings.
- No broad project-wide formatting scan.

Likely gates:

- Revit API support matrix documented.
- Runtime tests for operation validation if code is introduced.
- Live Revit gate only if native DLL or command payload behavior changes.

### S4: Model-save policy

Status: complete in PR #209.

Evidence:

- 27 `model_save_policy` calls.

Scope:

- Write the product policy before any save implementation.
- Decide whether revAgent exposes an explicit model-save tool at all. Current
  decision: no native save tool in the current product surface.
- If allowed later, define exact confirmation, blocked cases, reporting, and
  verification.

Non-goals:

- No implicit `document.Save()` from any normal write workflow.
- No implementation in the policy PR unless explicitly approved by a later
  product decision.

### S5: PDF/print policy and view/image asset split

Status: active.

Evidence:

- 54 `pdf_print_settings_policy` calls.
- 18 `view_image_asset_workflow` calls.

Scope:

- Keep PDF/print settings separate from evidence image export.
- Keep placed image asset mutation separate from view/sheet evidence export.
- Decide whether PDF output belongs in core, an add-on, or outside current
  automation. Current decision: outside the current core runtime surface;
  revisit only as a separately named office-profile add-on or policy-approved
  workflow.

Non-goals:

- No Revit `PrintManager` mutation without policy.
- No image asset placement/reload/crop mutation without a separate write
  contract.

### S6: Operational deploy follow-up

Evidence:

- During deployment of `2026.07.07.514-0c217fb3`, remote triggering of the
  normal scheduled update could hang behind user notification.
- A temporary no-notification scheduled task completed updates and reports on
  reachable machines.

Scope:

- Treat this as an operational product signal, separate from the usage pack.
- Consider a supported remote/manual no-notification update launcher or
  runbook-only helper.

Non-goals:

- Do not mix this into schedule/tool-routing PRs.
- Do not deploy changes from this stream without the same final deploy
  approval gate.

## Completion Definition

The usage-derived action plan is complete when:

- S1 through S5 are merged, or a later protocol note explicitly closes or
  reorders a workstream with evidence.
- Every merged PR has passed local targeted tests, required GitHub gates, and
  review.
- `main` is clean and up to date.
- A final deploy decision is requested from the user with a short summary of
  what changed and which machines or live gates still need attention.

