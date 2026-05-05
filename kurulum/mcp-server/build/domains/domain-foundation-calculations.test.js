import assert from "node:assert/strict";
import { classifyAabbClash, proposeOrthogonalReroute, solveOrthogonalReroute } from "./clash/calculations.js";
import { calculateFixtureDemand, checkRecirculationContinuity } from "./domestic-water/calculations.js";
import { buildEquipmentScheduleProposal, selectFanCandidate, selectPumpCandidate } from "./equipment/calculations.js";
import { checkSprinklerCoverage } from "./fire/calculations.js";
import { calculateSlopePercent, validateGravitySlope } from "./sanitary-storm/calculations.js";
import { buildAnalysisReport } from "../reporting/reportBuilder.js";

const fixtureDemand = calculateFixtureDemand({
    fixtureUnitTable: {
        lavatory: { coldFixtureUnits: 1, hotFixtureUnits: 1, totalFixtureUnits: 2 },
        wc: { coldFixtureUnits: 5, hotFixtureUnits: 0, totalFixtureUnits: 5 },
    },
    fixtures: [
        { fixtureType: "lavatory", count: 3 },
        { fixtureType: "wc", count: 2 },
    ],
});
assert.equal(fixtureDemand.success, true);
assert.equal(fixtureDemand.totals.coldFixtureUnits, 13);
assert.equal(fixtureDemand.totals.hotFixtureUnits, 3);
assert.equal(fixtureDemand.totals.totalFixtureUnits, 16);
assert.equal(calculateFixtureDemand().requiresOfficeStandard, true);

const continuity = checkRecirculationContinuity({
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    requiredLoopNodeIds: ["a", "b", "c"],
});
assert.equal(continuity.success, true);

const slope = calculateSlopePercent({ startElevationM: 10.0, endElevationM: 9.95, lengthM: 5.0 });
assert.equal(slope.success, true);
assert(Math.abs(slope.slopePercent - 1.0) < 1e-9);
const reverseSlope = validateGravitySlope({ startElevationM: 9.95, endElevationM: 10.0, lengthM: 5.0, minSlopePercent: 1.0 });
assert.equal(reverseSlope.success, false);
assert(reverseSlope.issues.includes("reverse_slope"));
assert.equal(validateGravitySlope({ startElevationM: 10, endElevationM: 9.95, lengthM: 5 }).requiresOfficeStandard, true);

const sprinklerOk = checkSprinklerCoverage({
    roomWidthM: 6,
    roomLengthM: 6,
    sprinklers: [{ x: 3, y: 3 }],
    maxSpacingM: 6.0,
    maxCoverageM2: 36,
});
assert.equal(sprinklerOk.success, true);
assert.equal(sprinklerOk.canCommit, false);
const sprinklerMissing = checkSprinklerCoverage({ roomWidthM: 6, roomLengthM: 6, sprinklers: [{ x: 3, y: 3 }] });
assert.equal(sprinklerMissing.requiresOfficeStandard, true);

const hardClash = classifyAabbClash({
    boxA: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    boxB: { min: { x: 0.5, y: 0.5, z: 0.5 }, max: { x: 1.5, y: 1.5, z: 1.5 } },
    clearanceM: 0.1,
});
assert.equal(hardClash.classification, "hard_clash");

const clearanceClash = classifyAabbClash({
    boxA: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    boxB: { min: { x: 1.05, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } },
    clearanceM: 0.1,
});
assert.equal(clearanceClash.classification, "clearance_clash");

const reroute = proposeOrthogonalReroute({
    routePoints: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
    obstacleBox: { min: { x: 2, y: -0.25, z: -0.25 }, max: { x: 3, y: 0.25, z: 0.25 } },
    clearanceM: 0.25,
    offsetAxis: "y",
});
assert.equal(reroute.success, true);
assert.equal(reroute.rerouteRequired, true);
assert.equal(reroute.canCommit, false);
assert(reroute.addedLengthM > 0);
assert.deepEqual(reroute.previewPoints[0], { x: 0, y: 0, z: 0 });
assert.deepEqual(reroute.previewPoints.at(-1), { x: 5, y: 0, z: 0 });

const solvedReroute = solveOrthogonalReroute({
    routePoints: [{ x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }],
    obstacleBoxes: [
        { min: { x: 2, y: -0.25, z: -0.25 }, max: { x: 3, y: 0.25, z: 0.25 } },
        { min: { x: 5, y: -0.35, z: -0.2 }, max: { x: 6, y: 0.35, z: 0.2 } },
    ],
    clearanceM: 0.25,
    candidateOffsetAxes: ["y", "z"],
});
assert.equal(solvedReroute.success, true);
assert.equal(solvedReroute.rerouteRequired, true);
assert.equal(solvedReroute.selectedCandidate.valid, true);
assert.equal(solvedReroute.selectedCandidate.violationCount, 0);
assert(solvedReroute.candidates.length >= 4);
assert(solvedReroute.selectedCandidate.addedLengthM > 0);
assert.deepEqual(solvedReroute.selectedCandidate.previewPoints[0], { x: 0, y: 0, z: 0 });
assert.deepEqual(solvedReroute.selectedCandidate.previewPoints.at(-1), { x: 8, y: 0, z: 0 });
assert.equal(solvedReroute.canCommit, false);

const fan = selectFanCandidate({
    requiredFlowM3h: 5000,
    requiredPressurePa: 450,
    candidates: [
        { id: "fan-a", flowM3h: 4800, pressurePa: 700 },
        { id: "fan-b", flowM3h: 5200, pressurePa: 500 },
        { id: "fan-c", flowM3h: 7000, pressurePa: 900 },
    ],
});
assert.equal(fan.success, true);
assert.equal(fan.selected.id, "fan-b");
assert.equal(fan.canCommit, false);

const pump = selectPumpCandidate({
    requiredFlowLs: 5,
    requiredHeadKPa: 80,
    candidates: [
        { id: "pump-a", flowLs: 5.5, headKPa: 75 },
        { id: "pump-b", flowLs: 5.5, headKPa: 85 },
    ],
});
assert.equal(pump.success, true);
assert.equal(pump.selected.id, "pump-b");
assert.equal(pump.canCommit, false);

const equipmentSchedule = buildEquipmentScheduleProposal({
    equipmentKind: "fan",
    requirement: { requiredFlowM3h: 5000, requiredPressurePa: 450 },
    selection: fan,
    targetElementId: 12345,
});
assert.equal(equipmentSchedule.success, true);
assert.equal(equipmentSchedule.scheduleRows.length, 1);
assert.equal(equipmentSchedule.scheduleRows[0].selectedId, "fan-b");
assert.equal(equipmentSchedule.writePlanSteps.length, 1);
assert.equal(equipmentSchedule.writePlanSteps[0].operation, "set_parameter");
assert.equal(equipmentSchedule.writePlanSteps[0].targets.elementId, 12345);
assert(equipmentSchedule.writePlanSteps[0].arguments.value.includes("selected=fan-b"));
assert.equal(equipmentSchedule.canCommit, false);

const report = buildAnalysisReport({
    analyses: [
        {
            discipline: "hvac",
            engine: "hvac-airside-foundation",
            status: "foundation",
            requiresOfficeStandard: true,
            missingStandards: ["hvac.ductEqualFrictionTargetPaPerM"],
            assumptions: ["proposal only"],
            engineeringMethods: ["weighted graph shortest path traversal"],
            revitRead: {
                success: true,
                counts: { ducts: 2, airTerminals: 3 },
                ductLengthMeters: 12.5,
                systemElementCounts: { "Supply Air": 5 },
            },
            canCommit: false,
        },
    ],
    delimiter: ";",
});
assert.equal(report.success, true);
assert.equal(report.issueRows.length, 1);
assert.equal(report.designLogRows.length, 1);
assert.equal(report.boqRows.length, 4);
assert(report.issueCsv.includes("missing_standard"));
assert(report.designLogCsv.includes("weighted graph shortest path traversal"));
assert(report.boqCsv.includes("Total duct length"));
assert(report.boqCsv.includes("Supply Air"));
assert.equal(report.canCommit, false);

console.log("domain foundation calculation tests passed");
