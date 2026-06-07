# WS4 Schedule-to-Excel Reconciliation Design Spike

Status: decision artifact for approval. This is doc-only; implementation waits
for explicit approval.

## Scope Decision

WS4 ships a runtime TypeScript reconciliation tool. It is review-first and
write-free:

- It reads a bounded Excel/table source and bounded Revit schedule evidence.
- It normalizes row identities, scores candidate matches, and returns a review
  table.
- It does not write Revit schedule cells.
- It does not write Excel files.
- Any follow-up write routes to a separate confirmed workflow after review.

The native Revit DLL is not the default implementation surface. Existing
schedule extraction tools are reused unless a later approved implementation PR
proves that the existing schedule evidence cannot provide the needed rows.

## Existing Spreadsheet-Reading Inventory

Current product/runtime inventory:

- `installer/runtime-mcp-server` has no registered Excel, spreadsheet, CSV, or
  workbook ingestion tool.
- The runtime package currently has no `.xlsx` or CSV parsing dependency. Its
  direct runtime dependencies are MCP SDK, `better-sqlite3`, `ws`, and `zod`.
- `installer/runtime-mcp-server/src/tools/register.ts` currently registers the
  Revit MCP tools; none consume spreadsheet files.
- The Codex Desktop Spreadsheets skill can create, inspect, and export
  workbooks through `@oai/artifact-tool`, but that is assistant-side artifact
  tooling. It is not a shipped revAgent runtime API and must not be the WS4
  product ingestion path.

Decision: WS4 implementation adds a runtime-owned spreadsheet ingestion helper.
The assistant-side spreadsheet skill may be used manually for investigation or
report formatting, but not as the canonical product ingest path.

## Excel Ingestion Decision

The MCP tool name is `reconcile_schedule_excel`.

Production ingestion uses an operator-provided local file path. The path may be
local or a NAS path, but it must be explicit. The tool never scans directories
for candidate workbooks.

Accepted Excel sources:

- `kind: "file"` with `path`, `format`, and selection fields.
- `kind: "rows"` with already materialized rows, only for CI fixtures,
  advanced integrations, and assistant-orchestrated dry runs.

Supported file formats:

- `.xlsx`: parsed inside the runtime helper with `exceljs`.
- `.csv` and `.tsv`: parsed inside the runtime helper with `csv-parse/sync`.
- `.xls`: not supported in WS4. It returns guarded
  `unsupported_excel_format` with instructions to save as `.xlsx` or `.csv`.

The runtime helper reads values only. It does not recalculate formulas. Formula
cells use their cached result when present; a formula without a cached result is
kept as blank for matching and reported in `warnings` with the workbook cell
address.

Sheet and range selection:

- `sheetName` is preferred.
- `sheetIndex` is accepted when a stable sheet name is not known.
- If no sheet is specified and exactly one non-empty sheet exists, that sheet is
  selected and a notice is returned.
- If no sheet is specified and multiple non-empty sheets exist, the result is
  guarded with `excel_sheet_selection_required`.
- `range` is optional A1 notation. If omitted, the selected sheet's used range
  is read.
- `headerRow` defaults to the first row of `range`, or row 1 when `range` is
  omitted.
- `dataStartRow` defaults to `headerRow + 1`.

Column mapping:

- Required semantic roles are `identity` and `comparisonText`.
- Optional roles are `code`, `description`, `quantity`, `unit`, `system`,
  `discipline`, and `notes`.
- The caller may supply exact column letters, indexes, or header names.
- If mapping is omitted, a deterministic alias resolver tries known aliases.
  Missing or non-unique required roles return guarded
  `excel_column_mapping_required`.
- Empty data rows are skipped but counted in `summary.emptyExcelRows`.

Excel row identity:

Each ingested row becomes an `excelRecord` with:

- `excelRowId`: stable string `sheetName!rowNumber`
- `sheetName`
- `rowNumber`
- `sourceRange`
- `rawValues`
- `mappedValues`
- `identityText`
- `comparisonText`
- `normalizedKey`
- `tokenProfile`

Budgets:

- `maxWorkbookBytes`: default 25 MB, hard max 100 MB.
- `maxSheets`: default 20.
- `maxRows`: default 5000, hard max 50000.
- `maxColumns`: default 100, hard max 300.
- `maxCells`: default 250000.
- `maxElapsedMs`: default 5000.

Workbook size and sheet count guards stop before parsing. Row, column, cell, or
elapsed limits return `partial: true` with canonical stop reasons and
continuation metadata where practical.

## Schedule Ingestion Decision

WS4 reuses `inspect_schedules` for Revit schedule extraction. It does not add a
new native schedule reader in the first implementation.

The reconciliation tool accepts schedule input in two concrete modes:

- `kind: "inspect_schedules_result"`: consumes a prior normalized
  `inspect_schedules` result. This is the CI fixture and deterministic unit
  test mode.
- `kind: "revit_schedule"`: accepts exact schedule scope arguments and invokes
  the existing `inspect_schedules` runtime/native bridge path internally. This
  mode must use exact `scheduleIds` or a bounded `nameQuery`; broad reads still
  require `allowExpensiveSearch=true`.

Required schedule row fields:

- `scheduleId`
- `scheduleName`
- `section`
- `row`
- `columnTexts`
- `identityText` source columns, configured by caller or inferred from headers
- `comparisonText` source columns, configured by caller or inferred from headers

Sections:

- Default section is `body`.
- `header` and `footer` may be read for evidence but do not become matchable
  data rows unless explicitly included.

Filtered and hidden row representation:

- The schedule source is the displayed schedule cell surface returned by
  `inspect_schedules`.
- Rows filtered out by the Revit schedule do not appear and are not treated as
  missing unless the caller supplies an external expected row list.
- Hidden or unreadable cells remain row evidence with warnings when
  `inspect_schedules` reports them; they are not silently promoted into
  matchable text.
- The output records `visibilityBasis: "displayedScheduleCells"` so reviewers
  know the schedule side is based on the visible/readable schedule result.

Schedule row identity:

Each matchable schedule row becomes a `scheduleRecord` with:

- `scheduleRowId`: stable string `scheduleId:section:row`
- `scheduleId`
- `scheduleName`
- `section`
- `row`
- `rawCells`
- `mappedValues`
- `identityText`
- `comparisonText`
- `normalizedKey`
- `tokenProfile`

## Normalization Decision

Matching is deterministic and does not use LLM calls.

Normalization pipeline:

1. Convert nullish values to an empty string.
2. Strip control characters.
3. Apply Unicode NFKC normalization.
4. Map Turkish casing variants before uppercasing: ASCII `i`, ASCII `I`,
   dotless i `U+0131`, and dotted capital I `U+0130` collapse to invariant
   `I`.
5. Map common Cyrillic lookalikes to Latin by code point. The initial set is
   uppercase `U+0410`, `U+0412`, `U+0415`, `U+041A`, `U+041C`, `U+041D`,
   `U+041E`, `U+0420`, `U+0421`, `U+0422`, `U+0425`, `U+0423` and lowercase
   `U+0430`, `U+0435`, `U+0432`, `U+043A`, `U+043C`, `U+043D`, `U+043E`,
   `U+0440`, `U+0441`, `U+0442`, `U+0445`, `U+0443`, mapped visually to
   `A`, `B`, `E`, `K`, `M`, `H`, `O`, `P`, `C`, `T`, `X`, and `Y`.
6. Convert the whole normalized string to invariant uppercase.
7. Normalize diameter markers `U+00D8`, `U+00F8`, and Cyrillic ef `U+0424`
   to `DN`.
8. Normalize recognized unit patterns such as `L/S`, `M3/H`, `KCAL/H`, and
   diameter expressions before generic separator replacement.
9. Convert decimal comma between digits to decimal dot.
10. Normalize separators, dash variants, underscores, slashes, punctuation, and
   parentheses to spaces unless they are part of a decimal number or an already
   canonical unit token.
11. Normalize unit spellings: `MM`, `M`, `CM`, `DN`, `L/S`, `M3/H`, `KW`, and
   `KCAL/H` become canonical unit tokens.
12. Collapse whitespace and trim.

Tokenization:

- Preserve ordered tokens.
- Emit token types: `code`, `number`, `unit`, `dimension`, and `word`.
- Keep alpha-numeric equipment/type codes as single `code` tokens when they
  contain both letters and numbers.
- Pair a number followed by a unit into a `dimension` token.
- Do not remove domain words by default. Any synonym or stopword behavior must
  be profile-driven in implementation, not hardcoded for one project code.

## Matching And Scoring Decision

Candidate generation:

- Exact normalized key candidates are considered first.
- Otherwise candidates are generated from shared code tokens, shared dimension
  tokens, or at least two shared significant word tokens.
- If no candidate is generated, the row is missing on the opposite side.

Score range is 0 to 100:

- 100: normalized keys are identical.
- Up to 35 points: significant token overlap using deterministic Dice
  coefficient.
- Up to 20 points: matching `code` tokens.
- Up to 20 points: matching `dimension` tokens.
- Up to 15 points: ordered token continuity.
- Up to 10 points: matching optional context fields such as `system`, `unit`,
  `quantity`, or `discipline`.

Hard caps:

- Conflicting code tokens cap the score at 64.
- Conflicting dimensions cap the score at 60.
- Conflicting unit tokens cap the score at 79.
- Duplicate exact normalized keys on either side are not auto-matched; they
  become ambiguity review rows.

Confidence buckets:

- `exactMatches`: score 100, unique source row, unique schedule row.
- `highConfidenceMatches`: score 86 to 99, no hard cap, and the top candidate
  beats the second candidate by at least 8 points.
- `possibleRenames`: score at least 86 with matching code or dimension tokens
  but differing descriptive tokens, or score 72 to 85 with no hard conflict.
- `ambiguousMatches`: score 65 to 71, top candidate gap under 8 points,
  duplicate exact keys, or multiple candidates sharing the same best score.
- `missingInSchedule`: Excel row has no schedule candidate at score 65 or
  higher.
- `missingInExcel`: schedule row has no Excel candidate at score 65 or higher.

No bucket implies an automatic write. Buckets only decide review priority.

## Review Output Decision

The MCP response uses a JSON review contract:

```json
{
  "success": true,
  "guarded": false,
  "state": "review_ready",
  "action": "reconcile_schedule_excel",
  "reconciliationContractVersion": 1,
  "partial": false,
  "scanStoppedReason": "completed",
  "summary": {
    "excelRows": 120,
    "scheduleRows": 118,
    "exactMatches": 90,
    "highConfidenceMatches": 12,
    "possibleRenames": 4,
    "ambiguousMatches": 5,
    "missingInSchedule": 9,
    "missingInExcel": 7
  },
  "reviewRows": [],
  "reviewTable": {
    "columns": [],
    "rows": []
  },
  "warnings": [],
  "notices": [],
  "suggestedNextActions": []
}
```

Each `reviewRows[]` item includes:

- `bucket`
- `score`
- `reason`
- `matchedTokens`
- `differingTokens`
- `hardConflicts`
- `excelRow`
- `scheduleRow`
- `candidateRows`
- `recommendedNextAction`

`reviewTable` is the Excel-style surface. It is returned as stable columns and
rows for copy/export by a separate assistant or reporting workflow. The WS4
tool itself does not create or modify a workbook.

Recommended actions are review labels only:

- `accept_match`
- `review_ambiguous`
- `create_schedule_row`
- `remove_or_ignore_schedule_row`
- `rename_excel_or_schedule_text`
- `no_action`

If a reviewer later wants to write Revit schedule cells, the assistant must
route to `set_schedule_cells` or `set_schedule_cells_by_text` in a separate
confirmed step. If a reviewer wants workbook edits, that is a separate
spreadsheet workflow with explicit confirmation.

## Deterministic CI Test Decision

Implementation PRs must add deterministic CI tests before the tool is treated
as usable:

- Excel ingest fixtures:
  - `.xlsx` with one selected sheet, explicit headers, formula cached values,
    and blank rows.
  - `.xlsx` with multiple non-empty sheets proving
    `excel_sheet_selection_required`.
  - `.csv` or `.tsv` proving delimiter and quote handling.
- Schedule ingest fixtures:
  - real-shape `inspect_schedules` normalized result with body rows.
  - partial schedule result proving `partial` and stop-reason propagation.
- Normalization fixtures:
  - whitespace, punctuation, dash variants, Turkish casing, Cyrillic
    lookalikes, diameter markers, decimal comma, and unit spellings.
- Matching fixtures:
  - exact match.
  - high-confidence spelling/punctuation variation.
  - possible rename.
  - duplicate exact keys becoming ambiguous.
  - tie within 8 points becoming ambiguous.
  - conflicting dimensions capped below high confidence.
  - missing-in-schedule and missing-in-Excel rows.

Tests must run in `npm test` and `scripts/test-ci.ps1`. They must not require
Revit, Excel desktop, NAS, or network access.

## Implementation Phasing Decision

After this design spike is approved:

1. PR 1: runtime Excel/CSV ingestion helper, schema, budgets, and deterministic
   ingest tests. No Revit calls.
2. PR 2: schedule record adapter from `inspect_schedules` output plus
   normalization/tokenization tests.
3. PR 3: deterministic matching/scoring engine plus bucket and explanation
   tests.
4. PR 4: `reconcile_schedule_excel` MCP tool registration, review JSON/table
   output, docs, and end-to-end dry-run tests.

If any PR changes the Revit DLL or command payload, it uses the standard
DLL/live-gate/deploy discipline. Runtime-only PRs still run local CI; the first
end-to-end PR that reads live schedules gets an operator live gate before merge.

## Final Decision Summary

- Excel ingestion is runtime-owned, not assistant-spreadsheet-skill-owned.
- Production input is an explicit file path; `rows` input exists for tests and
  advanced integrations.
- `.xlsx` uses `exceljs`; `.csv` and `.tsv` use `csv-parse/sync`; `.xls` is
  guarded unsupported.
- Schedule ingestion reuses `inspect_schedules`; no first-pass native reader is
  added.
- Matching is deterministic, score-based, capped by hard conflicts, and
  bucketed for review.
- Output is JSON plus an Excel-style table surface.
- The tool is write-free; write actions are separate confirmed workflows.
