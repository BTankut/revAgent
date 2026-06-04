# revAgent Large Model Search Plan

## Goal

Make revAgent useful and safe on very large production Revit models without
turning search into a blocking workflow. The desired behavior is progressive:
revAgent should first infer an engineering scope, run the cheapest meaningful
discovery step, then ask for operator control only when the next step is
materially expensive or ambiguous.

The core motto:

> revAgent does not stop the work by default. It uses MEP knowledge to narrow
> the first search, then gives the user control before expensive expansion.

## Problem

Large office models can contain many linked models, many worksets, and very
large MEP element counts. A read-only command can still be expensive when it
scans all host elements, linked elements, schedules, sheets, or plan visibility
candidates.

Observed production and full-test signals:

- Broad element text searches reached 60-120 second timeouts.
- Broad schedule and sheet text searches reached 60-120 second timeouts.
- A session/document verification step took about 59 seconds when it collected
  heavy link/category context.
- Focused inspections were acceptable: connector/type/focused searches were
  generally seconds, not minutes.

The problem is not just "read-only vs write". The problem is unbounded Revit
API traversal on large models.

## Non-Goals

- Do not simply increase timeouts as the primary fix.
- Do not make every broad search impossible.
- Do not force the user to specify a full scope for obvious MEP terms.
- Do not change controlled write semantics in this package.
- Do not implement deterministic Revit DLL builds or payload freshness changes
  here.
- Do not split the behavior into disconnected releases unless implementation
  risk forces it. The preferred delivery is one coherent pull request with
  clear internal staging.

## Review Decisions

The review comments are accepted with one product decision: keep this as one
coherent package, but make the internal staging explicit. Zone A and Zone B can
be implemented and tested separately inside the same pull request, yet the user
experience should land as one complete behavior change.

Accepted refinements:

- API-level category filtering is mandatory, not optional. Runtime inference
  reduces accidental broad searches, but the Revit bridge must also avoid
  collecting every instance element and filtering categories only in memory.
- `searchBudget` is the normal LLM-facing control. Low-level overrides such as
  `maxElementsScanned` and `maxElapsedMs` are advanced/debug controls.
- Revit-side elapsed budgets must stay below the outer socket timeout so a
  controlled partial result can return before transport timeout.
- New telemetry fields must be consumed by usage-intelligence/dashboard paths,
  not just emitted.
- `needs_scope` remains `state=guarded` plus `reason=needs_scope`; it is not a
  new top-level state.
- Large-model risk evaluation must not collect heavy category counts only to
  decide whether a model is large.
- CI-safe tests prove schema, defaults, guards, and telemetry flow; live Revit
  validation proves the actual traversal and performance behavior.

## Product Behavior

### Preferred Search Flow

For a request such as `find MTL fan coil`, revAgent should not treat the query
as a full-model free-text scan.

Expected interpretation:

- `fan coil` is a mechanical equipment concept.
- `MTL` is likely a family, type, name, mark, comment, or similar equipment
  text token.
- The first search should be host-model mechanical equipment discovery.
- Plan visibility verification should not run during the first broad pass.
- Sheet and schedule cell scans should not run unless the user asks for them or
  the workflow has already narrowed to specific sheets/schedules.

Expected first tool call shape:

- category narrowed to mechanical equipment
- `planCandidateMode = none`
- bounded result limit
- host model first unless link search is explicitly requested
- no sheet/schedule cell scan

If results are broad, revAgent should return grouped candidates and suggest
next scopes such as level, system, family/type, active view, sheet, or schedule.

### Controlled Expensive Search

Long searches remain allowed when the user intentionally chooses them.

The user should be able to request:

- deep host search
- linked model search
- all schedule search
- all sheet text search
- verified plan visibility

Those paths must be explicit, bounded where possible, and reported as expensive
with partial-result support when available.

### needs_scope Is Last Resort

`needs_scope` should be returned only when revAgent cannot infer a reasonable
engineering scope and the requested operation would otherwise scan a large or
unknown search surface.

Good candidates for `needs_scope`:

- a generic text query with no category or engineering term
- a request to search all model elements plus all links
- a request to scan all sheets or all schedule cells with no sheet/schedule
  name, id, or other bound
- a broad search combined with verified plan visibility
- a large-model risk signal plus no inferred scope and no explicit expensive
  search approval

## Design

### 0. Implementation Zones

This package has two different risk zones. They should be planned separately
inside the same pull request.

Zone A: prevention, runtime, and CI-safe behavior.

- search intent inference
- risk policy
- `needs_scope` guard behavior
- session `detailLevel=minimal`
- schedule/sheet progressive guards
- telemetry shaping
- documentation and smoke tests

Zone B: acceleration, Revit bridge, and live validation.

- API-level category/view/level filtering
- scan and elapsed budget enforcement inside the Revit external event handler
- token-aware matching
- partial result behavior
- Revit DLL rebuild and payload manifest update
- large-model live verification

Zone A reduces accidental expensive searches. Zone B is the load-bearing
performance fix for searches that should still run. Both are needed for the
product behavior described in this plan.

### 1. Search Intent and Scope Inference

Add a runtime-side helper that translates common engineering language into a
safe first search scope.

Responsibilities:

- identify MEP concepts in the query
- map concepts to Revit categories
- split engineering concept tokens from residual search tokens
- preserve user-provided explicit filters
- emit an audit summary in the result

Initial concept mappings:

| Concept terms | Inferred category candidates |
| --- | --- |
| fan coil, fcu, fancoil | Mechanical Equipment |
| ahu, air handling unit, klima santrali | Mechanical Equipment |
| pump, pompa | Mechanical Equipment |
| valve, vana | Pipe Accessories, Pipe Fittings |
| damper | Duct Accessories, Mechanical Equipment |
| diffuser, grille, air terminal | Air Terminals |
| duct, kanal | Ducts, Duct Fittings, Duct Accessories |
| pipe, boru | Pipes, Pipe Fittings, Pipe Accessories |
| sprinkler | Sprinklers |
| plumbing fixture, sanitary fixture | Plumbing Fixtures |

The helper should be conservative. If a term maps to more than one likely
category, use a small set of likely MEP categories rather than the whole model.

### 2. find_elements Tool Surface

Extend `find_elements` with explicit production filters and search budget
controls.

New or revised parameters:

- `levelNames`
- `levelIds`
- `activeViewOnly`
- `viewId`
- `familyName`
- `typeName`
- `systemName`
- `worksetNames`
- `worksetIds`
- `linkScope`: `hostOnly`, `linkedOnly`, `hostAndLinked`
- `searchBudget`: `fast`, `balanced`, `deep`
- `allowExpensiveSearch`

Advanced budget overrides may be exposed, but they should not be the normal LLM
path:

- `maxElementsScanned`
- `maxElapsedMs`

The common path should be `searchBudget`, with preset scan and elapsed limits.
This keeps the tool ergonomic for LLM use while still allowing precise
engineering/debug control when needed.

Result additions:

- `inferredScope`
- `effectiveScope`
- `scanPolicy`
- `scannedElementCount`
- `partial`
- `scanStoppedReason`
- `suggestedNextScopes`
- `warnings`
- `guarded`
- `state`
- `reason`

Compatibility:

- Existing `query`, `categoryNames`, `limit`, `planCandidateMode`, and
  `includePlanCandidates` behavior should continue to work.
- Default `planCandidateMode` remains `none` unless explicitly requested.
- Existing write-safety guidance stays in the response.

### 3. Revit Bridge Search Execution

The Revit command should avoid collecting every instance element when a more
specific collector is possible.

This is the load-bearing performance change. Runtime-side scope inference alone
is not sufficient if the bridge still collects every instance element and then
filters categories in memory. When category scope is known, the bridge should
use API-level category filters such as category-specific collectors or an
`ElementMulticategoryFilter` before materializing elements.

Execution priorities:

1. exact element id or unique id when supplied
2. active view collector when `activeViewOnly` or `viewId` is supplied
3. category-filtered collectors when category scope is known
4. host model first by default
5. linked document traversal only when `linkScope` requests it
6. bounded fallback traversal only when explicitly allowed

The event handler should support:

- scan count tracking
- elapsed time budget tracking
- partial result return before timeout when possible
- reasoned stop state such as `max_elapsed`, `max_scanned`, or
  `needs_expensive_search_approval`

Budget coordination rule:

- the in-Revit `maxElapsedMs` budget must be meaningfully smaller than the
  outer socket `timeoutMs`
- if both are supplied, clamp the Revit-side deadline below the socket deadline
- if only `searchBudget` is supplied, derive both the Revit-side deadline and
  socket timeout from the same preset with enough socket headroom for result
  serialization and transport

Without this coordination, the socket can time out before the handler returns a
partial result, turning a controlled search stop into a transport failure.

Matching should become token-aware enough to support queries like `MTL fan
coil`:

- concept token: `fan coil` narrows category
- residual token: `MTL` matches family/type/name/mark/comments
- exact matches still outrank contains matches
- family/type/mark matches outrank generic comments

### 4. Large Model Risk Policy

Add a lightweight risk policy shared by search tools.

Risk signals:

- high link count
- high workset count when available
- high known MEP category counts only when already available or explicitly
  requested
- large sheet/schedule counts
- previous timeout/partial signal in the same operation context when available

The policy must not require expensive counts just to decide whether counts are
expensive. It should use cheap document metadata first and heavy counts only
when explicitly requested or cached.

Category counts must never be collected automatically only for risk evaluation.
That would recreate the cost this policy is meant to avoid.

Policy output:

- `riskLevel`: `unknown`, `low`, `medium`, `high`
- `reasons`
- `recommendedFirstScope`
- `requiresUserControl`

When the policy guards an operation, keep the shared result contract stable:

- `success`: `true` or `false` according to existing runtime conventions
- `guarded`: `true`
- `state`: `guarded`
- `reason`: `needs_scope`

`needs_scope` is a reason, not a new top-level result state.

### 5. get_revit_session_context

Make the cheap path the default.

Add:

- `detailLevel`: `minimal`, `counts`, `full`

Default:

- `minimal`

Minimal mode should include:

- Revit version/build/culture
- document title/workshared/read-only state
- active view summary
- selection summary when requested
- cheap link instance summary if available without linked document scans

Counts/full mode may include:

- MEP category counts
- loaded link document counts
- linked room/space counts

Existing boolean flags should remain accepted for compatibility, but the
description should steer callers to `detailLevel`.

### 6. Schedule and Sheet Progressive Guards

`inspect_schedules` should remain useful for discovery but avoid accidental
full cell scans.

Policy:

- `nameQuery` or `scheduleIds` is preferred before cell reading.
- `cellQuery` without schedule scope can return a discovery-first suggestion
  unless `allowExpensiveSearch` is true.
- `includeCells` and `scanCells` stay bounded by row/column limits.

`inspect_sheet_text` should avoid accidental project-wide sheet, placed-view,
tag, or schedule traversal while still allowing intentional bounded
engineering searches.

Policy:

- `sheetQuery` or `sheetIds` is preferred before text search.
- `includeViewportTextNotes=true` inspects notes inside views placed on matching
  sheets and requires bounded sheet scope or explicit expensive approval.
- `scanScheduleCells=true` requires bounded sheet scope or explicit expensive
  approval.
- `includeViewportTags=true` stays opt-in; until native tag support is
  characterized it returns the stable `viewport_tags_deferred` response.
- The tool should suggest sheet number/name/view scope when it guards.

### 7. User-Facing Response Pattern

When revAgent can infer a scope:

> I searched this as Mechanical Equipment first because "fan coil" is an MEP
> equipment term. I found many candidates, grouped by level/type. To continue,
> choose a level, system, family/type, or allow a deeper search.

When revAgent cannot infer a scope:

> This search would scan a broad model surface and may slow Revit. Please narrow
> it by category, level, active view, system, sheet, schedule, family/type, or
> allow an explicit deep search.

When the user accepts a long search:

> Running an explicit deep search with bounded elapsed time and partial results.

## Telemetry

Add or preserve enough telemetry to verify the behavior in daily reports:

- inferred scope present or absent
- effective category count
- search budget
- link scope
- plan candidate mode
- expensive approval present or absent
- scanned element count
- partial result state
- needs_scope guarded count
- timeout count

Dashboard interpretation:

- `needs_scope` is a protected behavior, not a failed model operation.
- The main success metric is fewer 60-120 second broad-search timeouts without
  suppressing useful production searches.

Consumer requirement:

- dashboard and usage-intelligence readers must tolerate and surface the new
  search-policy fields
- smoke tests should assert that the fields flow through the telemetry summary
  path instead of being silently dropped

## Documentation Updates

Update:

- `SKILL.md`
- `AGENTS.md`
- `README.md`
- `docs/DEVELOPER_RUNBOOK.md`
- `docs/PLATFORM_ARCHITECTURE.md` if the tool contract changes materially

Documentation should say:

- infer engineering scope first
- run cheap discovery first
- avoid verified visibility for broad first-pass search
- use sheet/schedule cell scans only after bounded discovery or explicit user
  approval
- allow explicit deep search when the operator accepts the cost

Avoid wording that makes revAgent sound obstructive. The product stance is
control, not refusal.

## Testing

CI-safe tests:

- tool schema exposes the new parameters
- `find_elements` keeps `planCandidateMode=none` as the safe default
- smoke tests assert search policy language in tool descriptions
- telemetry summary includes new search policy fields where applicable
- dashboard/usage-intelligence smoke tests preserve new search policy fields
- session context defaults to minimal behavior
- schedule/sheet tools expose explicit expensive-search approval fields

Revit/live tests:

- `MTL fan coil` infers Mechanical Equipment and does not perform whole-model
  unfiltered traversal
- category-inferred searches use API-level category filters rather than
  collecting every instance element and filtering in memory
- broad generic text search returns `needs_scope` or asks for explicit deep
  approval on a large-risk model
- active view scoped search uses an active-view collector
- level scoped search filters results by level
- verified plan candidate search is opt-in and bounded
- schedule cell search without schedule scope is guarded or discovery-first
- sheet schedule-cell scan without sheet scope is guarded or discovery-first
- explicit deep search can run and reports partial/scan budget state when it
  stops early

Large-model live validation is required for the performance claim. CI-safe tests
can prove schemas, defaults, and guard behavior, but they cannot prove that the
Revit API traversal is fast enough on a real production-scale model.

## Acceptance Criteria

- `find MTL fan coil` does not stop immediately for missing scope. It performs
  a category-inferred Mechanical Equipment discovery pass.
- Generic scope-free searches on high-risk models do not silently run all-model
  deep scans.
- The user can intentionally allow expensive searches.
- The first broad discovery pass does not request verified plan candidates.
- Session context minimal mode does not perform heavy linked room/space or MEP
  category counts.
- Schedule and sheet tools avoid accidental all-project cell scans.
- Similar production logs show fewer 60-120 second broad search timeouts.
- Revit-side search budgets return partial/controlled results before socket
  timeout whenever possible.
- `needs_scope` is reported as `state=guarded` and `reason=needs_scope`, not as
  a new incompatible state.
- Documentation, runtime build payload, manifest, and CI-safe tests land in the
  same pull request.

## Rollout Plan

1. Implement Zone A runtime schema, shared search policy helper, and CI-safe
   guard behavior.
2. Change session context to minimal default with compatibility flags.
3. Add schedule/sheet progressive guard behavior.
4. Implement Zone B Revit bridge filters, scan budget, socket/budget
   coordination, and token-aware matching.
5. Add telemetry/dashboard/usage-intelligence flow tests.
6. Add docs and CI-safe smoke tests.
7. Run live Revit validation, including a large-model or large-risk scenario.
8. Build Revit payload and update the content-hash payload manifest.
9. Run local non-Revit gates.
10. Open one pull request and wait for required CI/reviews.
11. Merge once green.
12. Publish stable release after approval.
13. Verify a fresh main checkout deploy preflight does not create a separate
    payload-refresh PR.
14. Watch the next usage report for timeout reduction and guarded-scope
    quality.

## Risks

- Over-aggressive inference could miss valid elements in another category.
  Mitigation: report inferred scope and offer expansion.
- Too many new parameters could make the tool harder for LLMs to use.
  Mitigation: keep defaults intelligent and descriptions workflow-oriented.
- Linked model search may require careful result identity and transform
  reporting.
  Mitigation: start host-first and make link traversal explicit.
- Partial result support may be limited by the Revit external event execution
  model.
  Mitigation: enforce scan/elapsed checks inside the loop and return the best
  available result before socket timeout.
