import assert from "node:assert/strict";
import { classifyAabbClash, proposeOrthogonalReroute, solveOrthogonalReroute } from "./clash/calculations.js";
import { calculateFixtureDemand, checkRecirculationContinuity } from "./domestic-water/calculations.js";
import { buildEquipmentScheduleProposal, selectFanCandidate, selectPumpCandidate } from "./equipment/calculations.js";
import { checkSprinklerCoverage } from "./fire/calculations.js";
import { connectorPathElementIds, selectCriticalConnectorPath, summarizeLocalLossSamples } from "./local-losses/calculations.js";
import { readPathTargetedLocalLosses } from "./local-losses/path-targeting.js";
import { buildLocalLossOnlyCode } from "./local-losses/revit-read.js";
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

const localLossExtraction = summarizeLocalLossSamples({
    discipline: "hvac",
    sampleLimit: 2,
    samples: [
        {
            elementId: 201,
            uniqueId: "u-201",
            category: "Duct Fittings",
            systemName: "Supply Air",
            familyName: "Mitered Elbow",
            typeName: "300x300",
            lossParameters: [
                {
                    parameterName: "Pressure Drop",
                    parameterSource: "instance",
                    storageType: "Double",
                    valueKind: "pressure_drop_pa",
                    numericValue: 42,
                    displayValue: "42 Pa",
                },
                {
                    parameterName: "Loss Coefficient",
                    parameterSource: "type",
                    storageType: "Double",
                    valueKind: "loss_coefficient",
                    numericValue: 0.35,
                    displayValue: "0.35",
                },
            ],
        },
        {
            elementId: 202,
            uniqueId: "u-202",
            category: "Duct Accessories",
            systemName: "Supply Air",
            familyName: "Damper",
            typeName: "300x300",
            lossParameters: [],
        },
    ],
});
assert.equal(localLossExtraction.success, true);
assert.equal(localLossExtraction.inspectedElementCount, 2);
assert.equal(localLossExtraction.elementsWithLossParameters, 1);
assert.equal(localLossExtraction.localLossParameterCount, 2);
assert.equal(localLossExtraction.pressureDropParameterCount, 1);
assert.equal(localLossExtraction.lossCoefficientParameterCount, 1);
assert.equal(localLossExtraction.totalPressureDropPa, 42);
assert.equal(localLossExtraction.pressureContribution.totalPressureDropPa, 42);
assert(Math.abs(localLossExtraction.pressureContribution.totalPressureDropKPa - 0.042) < 1e-12);
assert.equal(localLossExtraction.pressureContribution.bySystem[0].systemName, "Supply Air");
assert.equal(localLossExtraction.pressureContribution.byCategory[0].category, "Duct Fittings");
assert.equal(localLossExtraction.rows[0].rowType, "local_loss_parameter");
assert.equal(localLossExtraction.canCommit, false);

const criticalPathSelection = selectCriticalConnectorPath({
    connectorPathfinding: {
        terminalPaths: [
            { elementId: 301, reachable: true, hopCount: 2, pathElementIds: [10, 20, 301] },
            { elementId: 302, reachable: true, hopCount: 4, pathElementIds: [10, 21, 22, 23, 302] },
            { elementId: 303, reachable: false, hopCount: -1, pathElementIds: [] },
        ],
    },
});
assert.equal(criticalPathSelection.success, true);
assert.equal(criticalPathSelection.selectedTerminalElementId, 302);
assert.deepEqual(criticalPathSelection.pathElementIds, [10, 21, 22, 23, 302]);
assert.deepEqual(connectorPathElementIds({
    connectorPathfinding: {
        terminalPaths: [
            { elementId: 301, reachable: true, pathElementIds: [10, 20, 301] },
            { elementId: 302, reachable: true, pathElementIds: [10, 21, 22, 23, 302] },
            { elementId: 303, reachable: false, pathElementIds: [10, 99, 303] },
        ],
    },
}), [10, 20, 301, 21, 22, 23, 302]);
const criticalPathLocalLossExtraction = summarizeLocalLossSamples({
    discipline: "hvac",
    samples: [],
    criticalPathSelection,
});
assert.equal(criticalPathLocalLossExtraction.targetedByCriticalPath, true);
assert.equal(criticalPathLocalLossExtraction.criticalPathSelection.selectedTerminalElementId, 302);
const pressureCriticalPathSelection = selectCriticalConnectorPath({
    connectorPathfinding: {
        terminalPaths: [
            { elementId: 401, reachable: true, hopCount: 5, pathElementIds: [10, 31, 32, 33, 34, 401] },
            { elementId: 402, reachable: true, hopCount: 2, pathElementIds: [10, 40, 402] },
        ],
    },
    localLossSamples: [
        {
            elementId: 40,
            lossParameters: [
                { valueKind: "pressure_drop_pa", numericValue: 125 },
            ],
        },
    ],
});
assert.equal(pressureCriticalPathSelection.strategy, "max_local_loss_pressure_drop");
assert.equal(pressureCriticalPathSelection.selectedTerminalElementId, 402);
assert.equal(pressureCriticalPathSelection.selectedTotalPressureDropPa, 125);
const pathTargetingCalls = [];
const pathTargetingResult = await readPathTargetedLocalLosses({
    pathCode: "pathfinding-code",
    categories: ["OST_DuctFitting"],
    sampleLimit: 2,
    executeRevitCode: async (code, options) => {
        pathTargetingCalls.push({ code, options });
        if (pathTargetingCalls.length === 1) {
            return {
                result: {
                    connectorPathfinding: {
                        terminalPaths: [
                            { elementId: 501, reachable: true, hopCount: 5, pathElementIds: [10, 51, 52, 53, 54, 501] },
                            { elementId: 502, reachable: true, hopCount: 2, pathElementIds: [10, 60, 502] },
                        ],
                    },
                },
            };
        }
        if (pathTargetingCalls.length === 2) {
            assert(pathTargetingCalls[1].code.includes("int[] targetElementIds = new int[] { 10, 51, 52, 53, 54, 501, 60, 502 }"));
            assert(pathTargetingCalls[1].code.includes("int sampleLimit = 8;"));
            return {
                result: {
                    localLossSamples: [
                        {
                            elementId: 60,
                            lossParameters: [
                                { valueKind: "pressure_drop_pa", numericValue: 75 },
                            ],
                        },
                    ],
                },
            };
        }
        assert(pathTargetingCalls[2].code.includes("int[] targetElementIds = new int[] { 10, 60, 502 }"));
        assert(pathTargetingCalls[2].code.includes("int sampleLimit = 3;"));
        return {
            result: {
                localLossSamples: [
                    {
                        elementId: 60,
                        category: "Duct Fittings",
                        systemName: "Supply",
                        lossParameters: [
                            { valueKind: "pressure_drop_pa", numericValue: 75 },
                        ],
                    },
                ],
            },
        };
    },
});
assert.equal(pathTargetingCalls.length, 3);
assert.equal(pathTargetingCalls[0].code, "pathfinding-code");
assert.deepEqual(pathTargetingCalls.map((call) => call.options), [
    { transactionMode: "none" },
    { transactionMode: "none" },
    { transactionMode: "none" },
]);
assert.deepEqual(pathTargetingResult.candidateTargetElementIds, [10, 51, 52, 53, 54, 501, 60, 502]);
assert.equal(pathTargetingResult.criticalPathSelection.strategy, "max_local_loss_pressure_drop");
assert.equal(pathTargetingResult.criticalPathSelection.selectedTerminalElementId, 502);
assert.deepEqual(pathTargetingResult.targetElementIds, [10, 60, 502]);
assert.equal(pathTargetingResult.localLossSamples[0].elementId, 60);

const targetedLocalLossCode = buildLocalLossOnlyCode({
    categories: ["OST_DuctFitting"],
    targetElementIds: [101, "bad", 0],
    sampleLimit: 5,
});
assert(targetedLocalLossCode.includes("int[] targetElementIds = new int[] { 101 };"));
assert(targetedLocalLossCode.includes("targeted = targetElementIds.Length > 0"));
assert(targetedLocalLossCode.includes("skippedTargetCount"));
assert(targetedLocalLossCode.includes("targetedReadComplete"));
const longTargetedLocalLossCode = buildLocalLossOnlyCode({
    categories: ["OST_DuctFitting"],
    targetElementIds: Array.from({ length: 250 }, (_, index) => index + 1),
    sampleLimit: 5,
});
assert(longTargetedLocalLossCode.includes("int sampleLimit = 250;"));
assert(longTargetedLocalLossCode.includes("uninspectedTargetCount"));
assert(longTargetedLocalLossCode.includes("truncatedBySampleLimit"));
const cappedGeneralLocalLossCode = buildLocalLossOnlyCode({
    categories: ["OST_DuctFitting"],
    sampleLimit: 500,
});
assert(cappedGeneralLocalLossCode.includes("int sampleLimit = 200;"));

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
            resistanceCalibration: {
                rows: [
                    {
                        elementId: 101,
                        uniqueId: "u-101",
                        systemName: "Hydronic Supply",
                        lengthM: 4,
                        diameterMm: 50,
                        referenceFlowLs: 1,
                        resistancePaPerFlow2: 20,
                        pressureLossPaAtReferenceFlow: 20,
                        velocityMpsAtReferenceFlow: 0.5,
                    },
                ],
            },
            localLossExtraction,
            canCommit: false,
        },
    ],
    delimiter: ";",
});
assert.equal(report.success, true);
assert.equal(report.issueRows.length, 1);
assert.equal(report.designLogRows.length, 1);
assert.equal(report.boqRows.length, 4);
assert.equal(report.hydraulicResistanceRows.length, 1);
assert.equal(report.localLossRows.length, 2);
assert.equal(report.localLossPressureRows.length, 3);
assert(report.issueCsv.includes("missing_standard"));
assert(report.designLogCsv.includes("weighted graph shortest path traversal"));
assert(report.boqCsv.includes("Total duct length"));
assert(report.boqCsv.includes("Supply Air"));
assert(report.hydraulicResistanceCsv.includes("Hydronic Supply"));
assert(report.localLossCsv.includes("Pressure Drop"));
assert(report.localLossPressureCsv.includes("local_loss_pressure_total"));
assert.equal(report.canCommit, false);

console.log("domain foundation calculation tests passed");
