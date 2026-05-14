# MEP Production Engineering Audit

Date: 2026-05-14

Scope:

- PR #13 connector graph foundation
- PR #14 ducting production evaluator
- PR #15 hydronic piping analysis
- PR #16 DCW/DHW sizing audit and write-back
- PR #17 sanitary/rainwater sizing and write-back
- PR #18 fire piping topology audit

## Audit Position

These packages are production foundations, not final design authorities. They are suitable for deterministic model QA, dry-run engineering checks, traceable recommendations, and manually gated Revit write-back where implemented.

They do not replace project code basis, authority review, manufacturer data, or engineer approval. Any table-driven sizing result must be checked against the active project standard before issue.

## Package Findings

### Connector Graph

Status: acceptable foundation.

- Uses shared `mep.connector-graph.v1` schema.
- Extractor/test strategy keeps graph generation read-only unless an explicit visualization/write workflow is used.
- Engineering consumers still need explicit discipline-specific roles over time. Current downstream modules often infer role from Revit text fields, which is useful for migration but not ideal as a permanent contract.

### Ducting

Status: safe as evaluator only.

- `evaluate_ducting_design` does not write Revit elements.
- Commit stage is only a readiness gate. It requires explicit approval, reviewed route candidate, connected network validation, and Revit native sizing validation.
- Engineering limitation: it is not a duct design engine and does not prove final HVAC design quality. It should remain upstream of a Revit/native/manual sizing workflow.

### Hydronic

Status: acceptable dry-run analysis.

- Calculates flow, velocity, Darcy-Weisbach or Hazen-Williams pressure drop, critical path, pump head, and balancing delta-P without Revit write-back.
- Reports `needs_review` when required flow/diameter/direction inputs are missing or ambiguous.
- Engineering limitation: results depend on reliable graph direction, pipe inside diameter, fluid properties, roughness, local loss/equivalent length, and terminal flow data.

### DCW/DHW

Status: write-back gated adequately.

- Audit tool is read-only and emits traceable sizing/write-back actions.
- Apply tool requires exact action-specific `approvalToken`, `confirmWriteBack='APPLY_DCW_DHW_WRITEBACK'`, `dryRun=false`, and Revit MCP status preflight with no active task.
- Engineering limitation: bundled fixture-unit conversion tables are project placeholders. Production use must provide project/code-approved tables.

### Sanitary/Rainwater

Status: hardened during this audit.

- Calculator produces table-driven recommendations and blocks write-back on errors.
- The write-back plan now includes a SHA-256 `approvalToken`, explicit `confirmWriteBack`, warning summary, and manual approval metadata.
- Apply tool now requires the static commit token, exact plan approval token, exact confirm text, explicit warning acknowledgement when warnings exist, and Revit MCP status preflight before sending model writes.
- Engineering limitation: bundled drainage tables are generic metric placeholders. Production write-back should use reviewed project/code tables.

### Fire Piping

Status: safe schematic topology audit.

- `audit_fire_piping_topology` is read-only.
- Report explicitly sets `hydraulicApproval: false`.
- Count-based sizing audit is marked schematic only and not hydraulic approval.
- Solver adapter reports missing hydraulic inputs instead of claiming compliance.
- Engineering limitation: final sprinkler/fire hose design still needs a reviewed hydraulic workflow with K-factor, density/area, hose allowance, C-factor, elevation, equivalent length, remote area, and applicable code basis.

## Verification Commands

- `scripts/test-all.ps1`
- `npm --prefix installer/runtime-mcp-server run build`
- `npm --prefix installer/runtime-mcp-server run sanitary-rainwater-test`
