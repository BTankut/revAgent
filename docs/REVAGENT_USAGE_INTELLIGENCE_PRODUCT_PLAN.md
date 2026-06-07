# revAgent Usage Intelligence Product Roadmap

Status: draft roadmap
Owner: revAgent product + Revit commandset + runtime wrapper
Source signal: usage-intelligence findings and operator feedback from production workflows.

## Roadmap, Not One PR

This document is a five-workstream roadmap, not a single-branch delivery plan.
Do not implement all workstreams in one PR.

Delivery order:

0. Lock the shared result contract first.
1. Ship `inspect_sheet_text` viewport tag evidence as its own hotfix PR.
2. Ship `inspect_schedules` partial/timeout behavior as its own hotfix PR.
3. Plan and ship the general annotation inventory/count tool as a separate
   project.
4. Plan and ship schedule-to-Excel reconciliation as a separate project.
5. Add usage-intelligence promotion tracking once the product surfaces exist.

Workstream 3 and Workstream 4 are each project-scale efforts, comparable in
size to the sheet-annotation #38 work. Workstream 3 uses the implementation
decisions in its roadmap section as the approval checkpoint instead of a
separate plan document. Workstream 4 still requires its own spike/plan
artifact. Both require a branch/PR sequence, live Revit validation, and release
gate. They must not be folded into the hotfix PRs.

The roadmap should keep the original product intent intact while respecting the
repo delivery model: small PRs, clear gates, and no merge/deploy without the
normal review and approval path.

## Execution Directive

This directive is binding. Execute the roadmap in order, with separate PRs and
explicit gates.

### Preserve Order And PR Boundaries

- Execute workstreams in the order listed in this document.
- Never combine more than one workstream into a single branch or PR.
- Treat Step 0 as its own PR.
- Do not start the next workstream until the previous workstream is merged.
- Branch each next workstream from clean, current `main`.
- Do not start Workstream 1 or Workstream 2 until the Step 0 shared contract is
  merged into `main`.

### Stop At Operator Live Gates

- For every PR that changes a DLL or command payload, wait for CI to pass, then
  stop before merge.
- Hand the PR to the operator for live Revit validation.
- The operator live gate is:
  1. close Revit
  2. install the branch payload
  3. open Revit
  4. run the agreed read-only live test
  5. approve or reject merge
- Merge only after operator approval.
- Do not bypass this gate.
- Do not autonomously merge or deploy a DLL/payload PR.

### Deployment Batching

- Pre-merge operator live gates remain mandatory for every PR that changes a
  DLL or command payload.
- Stable deploy is not a per-PR action. Batch stable deploy until the
  workstream is complete, then deploy once cumulatively after explicit operator
  deploy approval.
- A Revit-closed branch-payload install for live validation is not a stable
  deploy.
- For Workstream 3 specifically, WS3 PR 3 (`placed_schedule_cells` plus the
  batched per-sheet guard) and WS3 PR 4 (docs/release readiness) may be merged
  after their required gates, but must not be stable-deployed individually.
- When Workstream 3 is complete, perform one cumulative stable deploy for the
  whole workstream.

### Planning Gates For Workstream 3 And Workstream 4

- Do not code Workstream 3 directly.
- When Workstream 3 is reached, first lock the Implementation Decisions in this
  roadmap section, get approval, and then proceed with separate implementation
  PRs.
- Do not code Workstream 4 directly.
- When Workstream 4 is reached, first complete the mandatory design spike:
  - Excel ingestion path
  - schedule ingestion path
  - matching/scoring algorithm
  - review output decisions
- Do not write implementation code for Workstream 4 until the spike is complete
  and the follow-up plan is approved.
- When Workstream 3 or Workstream 4 is reached, produce the required
  implementation-decision or spike artifact and stop before implementation.

### Binding Execution Order

0. Step 0 shared contract, canonical native-result ingest, and real-shape
   fixture tests -> PR -> CI -> merge.
1. Workstream 1 viewport tags -> PR -> CI -> operator live Revit test -> merge.
2. Workstream 2 schedules partial -> PR -> CI -> operator live Revit test ->
   merge.
3. Workstream 3 annotation inventory/count -> Implementation Decisions in this
   roadmap section -> approval -> implementation PRs, each with the required
   live gate -> one cumulative stable deploy after the workstream is complete.
4. Workstream 4 schedule-to-Excel reconciliation -> design spike -> plan ->
   implementation PRs.
5. Workstream 5 usage-intelligence promotion tracking -> final roadmap step,
   with deterministic smoke coverage.

### Rationale

Single-workstream delivery limits blast radius. If something breaks, the
responsible workstream is clear, which is the lesson from #36, #37, and #38.
Every DLL/payload step depends on an operator live gate. Earlier real-world
validation should feed later workstream design instead of being discovered
after several features are already bundled together.
Pre-merge live validation and stable deployment are separate gates: validate
each DLL/payload PR before merge, but publish stable payloads once per
workstream unless the operator explicitly approves an emergency deploy.

## Goal

Turn repeated production friction into native, bounded, evidence-first revAgent
features.

The current signals point to two immediate hotfixes and two planned product
tools:

- `inspect_schedules` should return controlled partial results instead of
  leaving the user with a transport timeout.
- `inspect_sheet_text` should support real viewport tag evidence instead of
  returning only a deferred tag response.
- A general annotation inventory/count tool should cover sheet/view/tag/text
  and placed schedule code counting without project-specific hardcoding.
- A schedule-to-Excel reconciliation tool should match rows, explain
  differences, and produce a review table before any write workflow.

`Q/QHK 310.xxx` is an early production signal, not the product name and not a
hardcoded feature target. The product should support arbitrary profiles,
queries, and regexes for future code systems.

## Product Principles

1. Return partial evidence before socket or bridge timeout.
2. Make the difference between "no result" and "scan stopped early" explicit.
3. Keep broad scans possible, but bounded and transparent.
4. Prefer native Revit commandset ownership for long Revit traversal loops.
5. Keep TypeScript runtime tools as thin wrappers around native scan behavior.
6. Preserve existing response shapes; add new fields as backward-compatible
   supersets.
7. Avoid project-specific hardcoding inside native tools.
8. Produce evidence rows that another assistant can audit or turn into Excel.
9. Surface promotion candidates from usage intelligence, but keep
   prioritization human-owned.

## Step 0 - Shared Result Contract Prerequisite

Shared result-contract cleanup is not a later polish item. It is the first
roadmap step and a prerequisite for Workstream 1 and Workstream 2.

The lesson from #37 is that related tools must not invent separate partial,
guard, or evidence variants and then need compatibility work afterward. Before
either hotfix lands, lock the contract in one shared place and make both tools
conform to it from the start.

### Baseline Contract

Use the existing controlled-tool contract as the base:

- `success`
- `guarded`
- `state`
- `action`
- `partial`
- `scanStoppedReason`
- `scanPolicy`
- `suggestedNextScopes`
- `elapsedMs`
- `warnings`
- `notices`

Add the evidence and continuation fields required by this roadmap:

- `summary`
- `evidenceRows`
- `lastReadSection`
- `lastReadRow`
- `lastReadColumn`
- `lastReadSheetId`
- `lastReadViewId`
- `lastReadViewportId`
- `lastReadItemId`

Allowed stop reasons should be stable and reusable:

- `completed`
- `max_elapsed`
- `max_rows`
- `max_columns`
- `max_cells`
- `max_items`
- `max_bytes`
- `read_failed`
- `needs_scope`

### Contract Acceptance

- `inspect_sheet_text` and `inspect_schedules` use the same field names and
  stop-reason vocabulary.
- Step 0 includes the shared contract definition, one canonical casing-robust
  native-result ingest/normalizer, and fixture tests that exercise that ingest
  path directly. Step 0 is not only a field-name list.
- Existing successful responses remain backward-compatible supersets.
- Broad scans can distinguish no match from partial scan stop.
- Another assistant can read `summary`, `evidenceRows`, and
  `suggestedNextScopes` without tool-specific interpretation.
- Failed native reads and wrapper exceptions return `scanStoppedReason` of
  `read_failed`; failure paths are never labeled `completed`.
- Contract/characterization tests are fed by the producer's real output shape,
  including native handler serialization and dictionary-key casing such as
  PascalCase `Matches`. Idealized lowercase-only fixtures are not sufficient.
- Failure-path fixtures are required, including at least one `read_failed`
  schedule or annotation read scenario.
- Runtime wrappers must pass native bridge results through the shared
  casing-robust ingest/normalizer before reading contract fields. Wrappers must
  not directly read raw `payload.<field>` values for contract fields.

## Standard Native Workstream Discipline

Every native Revit traversal workstream in this roadmap must follow the same
delivery discipline used by `find_elements` and the sheet-annotation #38
pattern:

- Native handler owns budget, partial state, guard policy, deadline checks, and
  byte/response budgeting.
- TypeScript runtime code is a thin MCP wrapper and response normalizer.
- TypeScript wrappers use the shared casing-robust native-result ingest point
  for contract fields and native evidence collections. This applies the #37
  "one module" lesson to native-result casing instead of relying on reviewers
  or future assistants to remember casing edge cases.
- Output is a backward-compatible strict superset of the existing tool shape.
- CI-safe characterization tests cover schema, default caps, guard behavior,
  partial behavior, and representative stop reasons.
- CI-safe characterization tests must include producer-shaped native fixtures,
  including dictionary-key/PascalCase casing and `read_failed` failure paths.
  Lowercase-only fixtures cannot be the only contract proof.
- If a DLL changes, rebuild and commit the payload DLLs.
- If command payload changes, refresh `installer/revit-payload-manifest.json`.
- Before merge, run a live Revit validation gate for the changed behavior.
- At the workstream deployment point, run the Revit-closed install/deploy loop
  required for payload replacement. Do not treat per-PR live-validation installs
  as stable deploys.
- Docs, `SKILL.md`, and `AGENTS.md` are updated when tool routing or operator
  behavior changes.

## Workstream 1 - Hotfix: `inspect_sheet_text` Viewport Tag Evidence

### Problem

`inspect_sheet_text` has matured for sheet text notes, placed schedules, and
viewport text notes. Before Workstream 1, `includeViewportTags=true` still
returned a deferred response. Live validation showed readable
`IndependentTag.TagText` values in production models. The tag data is reachable;
the product surface must return real evidence instead of deferring.

### Desired Behavior

- `includeViewportTags=true` performs a bounded viewport tag scan.
- The source type is explicit:
  - `sheetTextNote`
  - `viewportTextNote`
  - `viewportTag`
  - `placedScheduleCell`
- Each tag evidence row includes fields where available:
  - `sheetId`
  - `sheetNumber`
  - `sheetName`
  - `viewportId`
  - `viewId`
  - `viewName`
  - `tagId`
  - `tagText`
  - `tagTextNormalized`
  - `tagFamilyName`
  - `tagTypeName`
  - `taggedElementId`
  - `taggedCategory`
  - `taggedFamilyName`
  - `taggedTypeName`
- Add scan caps:
  - `maxTags`
  - `maxViewports`
  - `maxElapsedMs`
  - `maxResponseBytes`
- Broad tag scans return `partial=true` and a clear `scanStoppedReason` when
  stopped.

### Native Discipline

- Native handler owns sheet, viewport, tag traversal, guard checks, elapsed
  budget, partial state, and byte budget.
- Runtime wrapper keeps the MCP tool name `inspect_sheet_text` and performs
  only lightweight parameter validation/normalization.
- Existing sheet text, viewport text, and placed schedule behavior remains a
  backward-compatible strict superset.
- CI-safe tests characterize opt-in tag parameters, default caps, defer
  removal, notices, partial stop reasons, and response fields.
- DLL changes require payload rebuild, manifest refresh, pre-merge live Revit
  gate, and Revit-closed deploy loop.

### Tag Fallback Discipline

Tag APIs vary by tag type. Unsupported or partially readable tag types should
produce `warnings` or `notices`, not whole-tool failure.

Expected fallback behavior:

- If `TagText` is available, return it even if tagged element metadata is not.
- If tagged element resolution fails, keep the tag evidence row and add a
  notice.
- If a tag type cannot expose usable text, report the skipped item in notices
  and continue.
- Do not regress to `viewport_tags_deferred` when readable tag evidence exists.

### Acceptance Criteria

- `includeViewportTags=true` returns real tag evidence in a live model where
  readable viewport tags exist.
- Tag API limitations are reported through `warnings` or `notices`, not
  failures.
- Large scans stop cleanly without locking Revit.
- Existing sheet text, viewport text note, and placed schedule workflows keep
  their existing fields and semantics.
- Contract fields from Step 0 are present and consistent.

### Dependencies And Gates

- Depends on Step 0 shared contract.
- Depends on the current sheet-annotation native commandset path.
- DLL/payload change expected: refresh manifest and run live Revit validation
  before merge.
- Revit must be closed for install/deploy validation when payload files are
  replaced.

### Expected File Areas

- native sheet annotation command/handler/helpers
- `installer/runtime-mcp-server/src/tools/inspect_sheet_text.ts`
- command registry and payload wiring
- `installer/revit-payload-manifest.json`
- `scripts/test-installer-smoke.ps1`
- docs, `SKILL.md`, `AGENTS.md`, and changelog

## Workstream 2 - Hotfix: `inspect_schedules` Partial/Timeout Contract

### Problem

`inspect_schedules` can already bound rows and columns and can report
`rowsTruncated`, but it does not expose the same mature partial-result contract
as the sheet/text inspection path. When production schedule reads hit timeout,
the operator gets a broken experience instead of useful progress.

### Desired Behavior

- Return as much schedule data as safely available before the timeout boundary.
- Add Step 0 contract fields to the top-level response.
- Include schedule-specific continuation fields:
  - `lastReadSection`
  - `lastReadRow`
  - `lastReadColumn`
- Include `suggestedNextScopes` when a broad read stops early.
- Suggestions should mention narrower `scheduleId`, section, row range, column
  range, or lower limits.
- Keep the old successful response shape compatible.

### Native Discipline

- Native handler owns schedule section/cell traversal, guard checks, elapsed
  budget, partial state, and byte budget when Revit-side traversal is required.
- Runtime wrapper keeps `inspect_schedules` as a thin MCP wrapper.
- Output is a backward-compatible strict superset of the current
  `inspect_schedules` response.
- CI-safe tests characterize `max_elapsed`, row/cell caps, byte caps, and
  backward-compatible small responses.
- DLL changes require payload rebuild, manifest refresh, pre-merge live Revit
  gate, and Revit-closed deploy loop.

### Implementation Notes

- Move elapsed-budget checks into the Revit-side schedule read loop if that
  loop is currently too close to the outer socket timeout.
- Track row, column, section, estimated response bytes, and read failures as
  first-class scan state.
- Keep existing parameters working.
- Add advanced/debug caps only where needed:
  - `maxElapsedMs`
  - `maxCells`
  - `maxResponseBytes`

### Acceptance Criteria

- Large or problematic schedules return `partial=true` instead of socket
  timeout when data was partially read.
- `scanStoppedReason=max_elapsed` is covered by tests.
- `scanStoppedReason=max_cells` or `max_rows` is covered by tests.
- `scanStoppedReason=max_bytes` is covered by tests.
- Existing successful small schedule responses remain backward-compatible.
- The response includes enough location state to guide the next call.
- Contract fields from Step 0 are present and consistent.

### Dependencies And Gates

- Depends on Step 0 shared contract.
- May depend on native commandset expansion if current runtime logic cannot
  safely return partial before transport timeout.
- If DLL changes, refresh manifest and run live Revit validation before merge.
- Revit must be closed for install/deploy validation when payload files are
  replaced.

### Expected File Areas

- `installer/runtime-mcp-server/src/tools/inspect_schedules.ts`
- native commandset schedule inspection command/handler if present or added
- command registry and payload wiring if native behavior is added
- `scripts/test-installer-smoke.ps1`
- `scripts/test-commandset-live.ps1` or equivalent live validation path
- docs and `SKILL.md` tool-routing notes

## Workstream 3 - Planned Project: General Annotation Inventory / Count

### Problem

Operators repeatedly need to count and audit codes across sheet text, viewport
text, viewport tags, and placed schedule cells. Today that pushes assistants
toward raw safe code. The same need will recur with damper codes, fire zones,
equipment labels, room notes, revision notes, system codes, and project-specific
annotation conventions.

### Product Shape

This is a separate project-scale workstream, not a hotfix add-on. It needs an
approved implementation-decision checkpoint, PR sequence, live validation
model, and release notes.

Add a general, parameterized annotation inventory/count surface. The selected
tool name for implementation is `count_annotations`.

The tool must not hardcode `Q/QHK 310.xxx`. That code family can be used only
as an example profile or validation scenario.

### Implementation Decisions

1. Reuse existing evidence and budget helpers by extraction, not duplication.
   WS3 implementation PRs must first extract and share the WS1 sheet evidence
   builders for text notes, viewport text notes, viewport tags, placed schedule
   cells, tag/tagged-element metadata, response-byte estimation, and suggested
   scopes, plus the WS2 schedule section/cell readers and schedule-cell
   evidence row builder. TypeScript wrappers reuse the existing broad-scan
   result helpers.
2. The four count semantics are fixed. `occurrence` counts every pattern match,
   including multiple matches in one source element or cell. `uniqueText`
   counts distinct normalized matched text per profile and grouping bucket.
   `uniqueTag` counts distinct `tagId` values from viewport tag evidence only.
   `uniqueTaggedElement` counts distinct resolved `taggedElementId` values from
   viewport tag evidence only; unresolved tagged elements are evidence with a
   warning, not counted. If a tag-specific count mode is requested without an
   explicit source list, the source list defaults to `viewport_tags`; if the
   caller explicitly combines a tag-specific count mode with non-tag sources,
   the tool returns a guarded validation result with
   `reason=invalid_count_mode_for_sources` and no fallback count mode.
   Characterization tests must cover repeated matches in one source, duplicate
   codes across sources, two tags pointing to one element, unresolved tags,
   non-tag source validation, and placed schedule cells.
3. Profiles are explicit input objects, not hardcoded product behavior. A
   profile has a stable name and one or more named patterns using `exact`,
   `contains`, `startsWith`, `regex`, or `normalizedRegex`. Simple query/regex
   inputs are normalized into an anonymous profile before native execution:
   `profileName` is `anonymous`, and pattern names are stable
   `anonymous.<matchMode>.<ordinal>` values unless the caller supplies names.
   Regex matching is bounded: pattern length is capped, candidate text is
   trimmed before matching, each regex runs with a native timeout, broad regex
   scans require explicit scope or `allowExpensiveSearch=true`, and invalid or
   timed-out regexes return guarded/noticed results instead of unbounded scans.
4. Workstream 3 implementation is multi-PR. After this decision checkpoint is
   approved, split implementation into focused PRs: shared helper extraction
   with no behavior change, core read-only annotation inventory/count for sheet
   text and viewport tag evidence, placed schedule-cell integration and
   continuation polish, then docs/release readiness. The placed schedule-cell
   integration PR also batches the per-sheet scan guard deferred from the
   core-count review cycle: wrap the per-sheet scan body once, return one
   warning for a corrupt/problem sheet, and continue. Do not open a solo PR or
   solo live-gate cycle only for that guard. Every PR that changes a DLL or
   command payload has its own CI, bot review, operator live gate, and merge
   approval. Stable deploy is batched: WS3 PR 3 and WS3 PR 4 may merge after
   their gates, but neither is deployed individually; deploy WS3 once
   cumulatively after the workstream is complete.
5. The core inventory/count implementation PR covers `sheet_text_notes` and
   `viewport_tags` only. `placed_schedule_cells` remains in the later
   integration/continuation PR so this PR can lock the four count semantics and
   bounded profile model without expanding source traversal.

### Native Discipline

- Native handler owns sheet/view/text/tag/schedule-cell traversal, guard
  policy, elapsed budgets, partial state, and byte budget.
- TypeScript runtime wrapper owns MCP schema and response normalization only.
- Output follows Step 0 and is designed as a stable evidence surface, not a
  one-off report generator.
- CI-safe characterization tests cover source selection, match modes, grouping,
  count semantics, partial stops, and response budget behavior.
- DLL changes require payload rebuild, manifest refresh, pre-merge live Revit
  gate. Stable deploy waits until the end of the Workstream 3 batch.

### Implementation Status

- WS3 implementation PRs PR 43, PR 44, and PR 46 have landed the shared helpers,
  core count semantics, viewport tag evidence, placed schedule-cell source, and
  per-sheet guard batching.
- WS3 PR 4 is docs/release readiness only. It must not change DLL or runtime
  command payload behavior, does not require a live Revit gate if it stays
  documentation-only, and still merges without individual stable deploy.
- After WS3 PR 4 merges, Workstream 3 is ready for one cumulative stable deploy
  covering PR 43, PR 44, PR 46, and PR 4, but that deploy requires a separate
  human approval.

### Inputs

Scope:

- `sheetIds`
- `sheetQuery`
- `viewIds`
- `viewQuery`
- active view or active sheet

Sources:

- `sheet_text_notes`
- `viewport_text_notes`
- `viewport_tags`
- `placed_schedule_cells`

Match modes:

- `exact`
- `contains`
- `startsWith`
- `regex`
- `normalizedRegex`

Grouping:

- `sheet`
- `view`
- `sourceType`
- `matchedCode`
- `tagFamilyType`
- `taggedElement`

Counting modes:

- `occurrence`
- `uniqueText`
- `uniqueTag`
- `uniqueTaggedElement`

### Outputs

- `summary`
- count matrix by sheet/view/code/source
- `evidenceRows` for every match
- normalized text and raw text
- source id and Revit element id
- matched pattern/profile name
- count semantics used
- partial and scan policy fields from Step 0

### Acceptance Criteria

- `Q/QHK 310.xxx` counting works as one example profile.
- The same tool can count a different code family by changing regex/profile.
- Count semantics are explicit: raw occurrence, unique text, unique tag, or
  unique tagged element.
- Evidence rows can be exported or copied into an Excel-style review table.
- Contract fields from Step 0 are present and consistent.

### Dependencies And Gates

- Depends on Workstream 1 viewport tag evidence.
- Depends on Workstream 2 schedule partial behavior for placed schedule cell
  scale and continuity.
- Requires approved Implementation Decisions in this section before
  implementation.
- DLL/payload change expected: refresh manifest and run live Revit validation
  before merge.
- Revit must be closed for branch-payload install/live validation when payload
  files are replaced.
- Stable deploy is batched to the end of Workstream 3; WS3 PR 3 and WS3 PR 4
  merge without individual deploys.

## Workstream 4 - Planned Project: Schedule-to-Excel Reconciliation

### Problem

DL-02/KLOP-style workflows need row-name reconciliation between Revit schedules
and Excel tables. `set_schedule_cells_by_text` can find schedule rows, but this
need is not primarily a Revit write. It is matching, difference analysis, and
human review before any write.

### Product Shape

This is a separate project-scale workstream, not a hotfix add-on. It needs its
own plan, branch/PR sequence, representative test data, and live validation.

The reconciliation engine is not a Revit native tool. It should be a
TypeScript/runtime matching tool that consumes schedule data and Excel/table
data, normalizes names, scores possible matches, and returns a review table.
Revit native code should only be used for schedule extraction if an existing
runtime tool cannot provide the needed schedule rows safely.

Writing to Revit or Excel should be a separate, confirmed step.

### Mandatory Design Spike

Do not implement reconciliation before this design spike is complete.

The spike must decide:

- Excel ingestion path:
  - Does the operator provide a file path?
  - Does the assistant use an existing spreadsheet-reading tool?
  - Is `.xlsx` parsed directly by a runtime helper?
  - What sheet/range selection model is used?
- Schedule ingestion path:
  - Does the workflow call `inspect_schedules` first?
  - Which row identity and section fields are required?
  - How are filtered/hidden schedule rows represented?
- Matching/scoring algorithm:
  - normalization pipeline
  - tokenization rules
  - Latin/Cyrillic lookalike handling
  - unit/dimension normalization
  - confidence thresholds
  - ambiguous-match handling
  - token diff explanation format
- Review output:
  - JSON shape
  - optional Excel-style table output
  - how follow-up write actions are routed for confirmation

### Normalization Requirements

Handle common production differences:

- whitespace
- dash and punctuation variants
- Latin/Cyrillic lookalike characters
- unit spelling differences
- uppercase/lowercase
- type code versus description versus dimension fragments

### Outputs

- `exactMatches`
- `highConfidenceMatches`
- `ambiguousMatches`
- `missingInSchedule`
- `missingInExcel`
- `possibleRenames`

Every match should include:

- match score
- reason
- matched tokens
- differing tokens
- source row identity
- schedule row identity
- recommended next action

### Runtime Discipline

- Runtime matching code owns normalization, scoring, confidence buckets, and
  explanation fields.
- Revit native code is not the default implementation surface.
- The tool remains review-first and write-free.
- CI-safe deterministic tests cover normalization, scoring, ambiguity, missing
  rows, and threshold behavior.
- If schedule extraction requires native DLL changes, apply the standard DLL,
  manifest, live-gate, and Revit-closed deploy discipline.

### Acceptance Criteria

- The tool does not write Revit schedule cells.
- The first output is a reconciliation table.
- Ambiguous matches remain review items, not automatic changes.
- If a write is needed, the workflow routes to a separate confirmed
  spreadsheet or Revit write path.
- Design spike decisions are recorded before implementation begins.

### Dependencies And Gates

- Depends on the Step 0 contract for summary/evidence-style output, but does
  not require native traversal by default.
- Depends on a stable Excel ingestion decision from the design spike.
- Requires deterministic matching/scoring tests before live workflow testing.
- Requires representative schedule + spreadsheet validation data.

## Workstream 5 - Usage-Intelligence Promotion Tracking

### Problem

Usage intelligence currently surfaces friction, but new native-tool candidates
should become easier to track from repeated assistant behavior.

### Desired Behavior

Usage summaries should identify promotion candidates for:

- repeated raw/safe code patterns
- repeated timeout/partial-result friction
- repeated annotation counting requests
- repeated schedule-to-spreadsheet reconciliation requests
- repeated manual transaction/write guards

Promotion means "surface as a candidate." It does not mean automatic
prioritization. A human still decides whether a candidate becomes hotfix,
planned work, or watch-only.

Weak evidence marking must remain explicit for small samples, smoke-test-heavy
days, or one-off workflows.

### Suggested Summary Fields

- `promotionCandidates`
- `nativeToolCandidates`
- `hotfixCandidates`
- `reconciliationCandidates`
- `annotationInventoryCandidates`
- evidence snippets with session/tool context
- `evidenceStrength`
- `humanReviewRequired`

### Smoke And Edge-Pillar Requirement

Add deterministic smoke coverage that proves the new fields flow through the
full edge pillar:

1. telemetry/event input
2. usage summarizer
3. published usage summary
4. dashboard/report consumer

The test should assert that candidate fields are present when source evidence
exists and absent or weak-marked when evidence is thin.

### Acceptance Criteria

- New candidate categories appear in daily summaries when the source signal is
  present.
- The summary distinguishes hotfix candidates from planned product tools.
- Small samples are marked as weak evidence instead of overpromoted.
- Deterministic smoke proves telemetry-to-usage-to-dashboard flow.
- Human review remains part of promotion; no automatic priority escalation.

### Dependencies And Gates

- Depends on at least one implemented product surface or a deterministic fixture
  representing it.
- Requires `docs/REVAGENT_USAGE_INTELLIGENCE.md` update if summary schema
  changes.
- Requires CI-safe deterministic summary/dashboard smoke coverage.

## Binding Implementation Order

Use the `Execution Directive` above as the binding sequence and gate policy.
This is not a suggestion.

0. Step 0 shared result contract, canonical casing-robust native ingest
   normalizer, and real-shape fixture tests -> PR -> CI -> merge.
1. Workstream 1 `inspect_sheet_text` viewport tag hotfix -> PR -> CI ->
   operator live Revit test -> merge.
2. Workstream 2 `inspect_schedules` partial/stop-reason hotfix -> PR -> CI ->
   operator live Revit test -> merge.
3. Workstream 3 general annotation inventory/count -> Implementation Decisions
   in this roadmap section -> approval -> implementation PRs, each with the
   required live gate -> one cumulative stable deploy after the workstream is
   complete.
4. Workstream 4 schedule-to-Excel reconciliation -> mandatory design spike ->
   plan -> implementation PRs.
5. Workstream 5 usage-intelligence promotion tracking -> deterministic smoke
   coverage -> PR -> CI -> merge.

This order is binding. Workstream 3 depends on mature sheet text, viewport
text, viewport tag, and placed schedule evidence. Workstream 4 has its own
design unknowns and must not start before Excel ingestion and matching/scoring
are specified.

## Validation Gates

Local gates:

- TypeScript build and smoke tests for runtime wrappers.
- Commandset build when native Revit traversal changes.
- Installer smoke tests for command registry and payload packaging.
- Payload manifest freshness checks when DLLs or command payloads change.

Live Revit gates:

- Bounded sheet text scan with viewport tags enabled.
- Large schedule read that returns partial before timeout.
- Annotation inventory example with a non-hardcoded regex/profile.
- Reconciliation dry run using a representative schedule and spreadsheet table.

Documentation gates:

- `SKILL.md` updated with new routing rules.
- `AGENTS.md` updated if operator behavior or tool-selection rules change.
- `docs/REVAGENT_USAGE_INTELLIGENCE.md` updated if summary schema changes.
- Changelog entry added for every shipped behavior change.

## Backlog Cards

### Title: Lock shared broad-scan result contract

Evidence: Related broad-scan tools need the same partial, guard, stop-reason,
and evidence semantics before new hotfixes diverge.

Why it matters: Avoids #37-style follow-up compatibility work.

Suggested change: Define the shared contract once, update tests, and require
WS1/WS2 to consume it.

Risk: Low-medium. Main risk is touching shared response normalization without
breaking existing clients.

Priority: Hotfix prerequisite

### Title: Implement viewport tag evidence in `inspect_sheet_text`

Evidence: `includeViewportTags=true` previously returned deferred behavior
while live models expose readable tag text.

Why it matters: Sheet and placed-view annotation verification is a recurring
production workflow.

Suggested change: Add bounded native viewport tag scan and evidence rows with
tag/source/tagged-element metadata where available.

Risk: Medium-high. Revit tag APIs vary by tag type; unsupported cases need
notices, not failures.

Priority: Hotfix

### Title: Add partial-result contract to `inspect_schedules`

Evidence: Production schedule reads can return truncation or timeout without
enough continuation state.

Why it matters: Operators need usable partial data and next-scope guidance, not
a disconnected timeout.

Suggested change: Add `partial`, `scanStoppedReason`, `scanPolicy`,
`elapsedMs`, last-read position fields, byte/cell/time caps, and tests.

Risk: Medium. Schedule APIs can be sensitive to section and cell access
failures; keep behavior backward-compatible.

Priority: Hotfix

### Title: Add general annotation inventory/count tool

Evidence: Users need repeated code counts across text notes, tags, and placed
schedules; raw code is becoming the workaround.

Why it matters: Counting annotations is a reusable production task across many
project code systems.

Suggested change: Add a profile/regex-driven inventory/count tool with scoped
sources, grouping, count modes, summary matrix, and evidence rows.

Risk: Medium. Scope and count semantics must be explicit to avoid misleading
quantities.

Priority: Planned project

### Title: Run schedule-to-Excel reconciliation design spike

Evidence: DL-02/KLOP-style work shows row-name matching friction between Revit
schedules and Excel tables, but ingestion and scoring are not yet specified.

Why it matters: Implementation before design would lock in the wrong tool
boundary.

Suggested change: Decide Excel ingestion, schedule ingestion, scoring,
confidence thresholds, token diff output, and write-routing boundaries.

Risk: Medium. Matching confidence must remain conservative and reviewable.

Priority: Planned project prerequisite

### Title: Track promotion candidates in usage intelligence

Evidence: Usage intelligence is now producing product signals, but the summary
should separate hotfix, planned-tool, and watch categories more explicitly.

Why it matters: Repeated production friction should become a visible product
queue without manual log archaeology.

Suggested change: Add promotion-candidate categories for broad-scan partial
needs, annotation counting, reconciliation, and repeated raw-code patterns,
with deterministic telemetry-to-dashboard smoke coverage.

Risk: Low-medium. Avoid overinterpreting small or smoke-test-heavy samples.

Priority: Planned
