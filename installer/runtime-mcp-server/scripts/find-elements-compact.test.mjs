import assert from "node:assert/strict";
import { compactFindElementsResult } from "../build/tools/find_elements.js";

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

console.log("find_elements compact tests passed");
