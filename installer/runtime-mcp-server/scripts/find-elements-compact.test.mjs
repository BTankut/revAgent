import assert from "node:assert/strict";
import { addWriteSafetyGuidance, compactFindElementsResult } from "../build/tools/find_elements.js";

const repeatedPlanCandidates = [
  {
    Id: 3101,
    Name: "L08 Mechanical Plan",
    ViewType: "FloorPlan",
    LevelName: "Level 08",
    ElementVisibleInView: true,
    DebugGeometry: { crop: "large native detail omitted in compact" },
  },
  {
    Id: 3102,
    Name: "L08 Coordination Plan",
    ViewType: "FloorPlan",
    LevelName: "Level 08",
    ElementVisibleInView: null,
    DebugGeometry: { crop: "large native detail omitted in compact" },
  },
];

const nativeShapePayload = {
  Success: true,
  Count: 2,
  Elements: [
    {
      Id: 1001,
      Name: "FCU-101",
      Category: "Mechanical Equipment",
      PlanCandidates: repeatedPlanCandidates,
    },
    {
      Id: 1002,
      Name: "FCU-102",
      Category: "Mechanical Equipment",
      PlanCandidates: repeatedPlanCandidates.map((candidate) => ({ ...candidate })),
    },
  ],
};

const compact = compactFindElementsResult(nativeShapePayload, {
  responseMode: "compact",
  maxResultRows: 25,
  maxPlanCandidates: 2,
});

assert.equal(compact.responseMode, "compact");
assert.equal(compact.Elements.length, 2);
assert.equal(compact.planCandidateSummary.candidateRowCount, 4);
assert.equal(compact.planCandidateSummary.uniqueCandidateCount, 2);
assert.equal(compact.planCandidateSummary.returnedCandidateCount, 2);
assert.equal(compact.planCandidateSummary.duplicateCandidateRowCount, 2);
assert.equal(compact.summary.planCandidateRowCount, 4);
assert.equal(compact.summary.uniquePlanCandidateCount, 2);
assert.equal(compact.Elements.every((element) => !("PlanCandidates" in element) && !("planCandidates" in element)), true);
assert.equal(compact.Elements.every((element) => Array.isArray(element.planCandidateRefs)), true);
assert.equal(compact.Elements.every((element) => element.planCandidateRefs.length === 2), true);
assert.deepEqual(compact.Elements[0].planCandidateRefs, [{ ref: "3101" }, { ref: "3102" }]);
assert.equal("id" in compact.Elements[0].planCandidateRefs[0], false);
assert.equal("name" in compact.Elements[0].planCandidateRefs[0], false);
assert.equal(JSON.stringify(compact).includes("DebugGeometry"), false);
assert.match(compact.notices.join("\n"), /planCandidateSummary/);

const full = compactFindElementsResult(nativeShapePayload, { responseMode: "full" });
assert.equal(full.responseMode, "full");
assert.equal(Array.isArray(full.Elements[0].PlanCandidates), true);
assert.equal(JSON.stringify(full).includes("DebugGeometry"), true);

const manyUniquePlanCandidates = compactFindElementsResult({
  Success: true,
  Elements: [
    {
      Id: 2001,
      Name: "Pump A",
      PlanCandidates: [
        { Id: 4101, Name: "L01 Mechanical Plan" },
        { Id: 4102, Name: "L01 Coordination Plan" },
      ],
    },
    {
      Id: 2002,
      Name: "Pump B",
      PlanCandidates: [
        { Id: 4201, Name: "L02 Mechanical Plan" },
        { Id: 4202, Name: "L02 Coordination Plan" },
      ],
    },
  ],
}, {
  responseMode: "compact",
  maxPlanCandidates: 1,
});
assert.equal(manyUniquePlanCandidates.Elements.every((element) => element.planCandidateRefs.length === 1), true);
assert.equal(manyUniquePlanCandidates.planCandidateSummary.uniqueCandidateCount, 4);
assert.equal(manyUniquePlanCandidates.planCandidateSummary.returnedCandidateCount, 4);
assert.equal(manyUniquePlanCandidates.planCandidateSummary.omittedCandidateCount, 0);

const broadWriteSafety = addWriteSafetyGuidance({
  Success: true,
  Count: 12,
  ambiguous: true,
  truncated: false,
  topConfidence: "medium",
  SelectionHint: "Narrow the search before acting.",
});
assert.equal(broadWriteSafety.writeSafety.sufficientForWrite, false);
assert.equal(broadWriteSafety.writeSafety.discoveryEvidenceOnly, true);
assert.equal(broadWriteSafety.writeSafety.writeBlockedUntil, "exact_element_and_parameter_schema_preflight");
assert.deepEqual(broadWriteSafety.writeSafety.requiredPreflightTools, ["inspect_elements", "inspect_parameter_schema", "set_element_parameter"]);
assert.equal(broadWriteSafety.writeSafety.resultRisk.broadOrAmbiguous, true);
assert.equal(broadWriteSafety.writeSafety.resultRisk.unsafeForParameterWriteReason, "broad_or_ambiguous_discovery_result");
assert.match(broadWriteSafety.writeSafety.parameterWritePolicy, /Never commit set_element_parameter from find_elements rows alone/);
assert.match(broadWriteSafety.writeSafetyWarning, /Never commit parameter writes from find_elements rows alone/);
assert.match(broadWriteSafety.SelectionHint, /inspect_parameter_schema/);
assert.match(broadWriteSafety.warnings.join("\n"), /broad or ambiguous/);
assert.deepEqual(broadWriteSafety.notices, ["find_elements_discovery_only_parameter_write_preflight_required"]);

const singleCandidateWriteSafety = addWriteSafetyGuidance({
  Success: true,
  Count: 1,
  ambiguous: false,
  truncated: false,
  topConfidence: "high",
  selectionHint: "One likely candidate found.",
});
assert.equal(singleCandidateWriteSafety.writeSafety.sufficientForWrite, false);
assert.equal(singleCandidateWriteSafety.writeSafety.resultRisk.broadOrAmbiguous, false);
assert.equal(singleCandidateWriteSafety.writeSafety.resultRisk.unsafeForParameterWriteReason, "discovery_tool_result_not_parameter_write_evidence");
assert.match(singleCandidateWriteSafety.selectionHint, /set_element_parameter in dryRun/);

console.log("find_elements compact tests passed");
