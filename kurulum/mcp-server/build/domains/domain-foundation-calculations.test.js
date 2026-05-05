import assert from "node:assert/strict";
import { classifyAabbClash, proposeOrthogonalReroute, solveOrthogonalReroute } from "./clash/calculations.js";
import { calculateDomesticWaterPressureLoss, calculateFixtureDemand, checkRecirculationContinuity, convertFixtureUnitsToDemand, sizeDomesticWaterPipe } from "./domestic-water/calculations.js";
import { buildEquipmentScheduleProposal, buildFamilyPlacementProposal, selectFanCandidate, selectPumpCandidate } from "./equipment/calculations.js";
import { calculateFireCabinetDemand, calculateFirePumpBasis, checkFireCabinetCoverage, checkSprinklerCoverage } from "./fire/calculations.js";
import { analyzeHvacAirside } from "./hvac/index.js";
import { analyzeHydronic } from "./hydronic/index.js";
import { connectorPathElementIds, selectCriticalConnectorPath, summarizeLocalLossSamples } from "./local-losses/calculations.js";
import { readPathTargetedLocalLosses } from "./local-losses/path-targeting.js";
import { buildLocalLossOnlyCode } from "./local-losses/revit-read.js";
import { analyzeDomainPlacement } from "./placement/index.js";
import { calculateSlopePercent, calculateStormRunoffRational, checkVentContinuity, sizeGravityPipeByFixtureUnits, sizeStormPipeByFlow, traceGravityDrainageToStack, validateGravitySlope } from "./sanitary-storm/calculations.js";
import { mergeOfficeStandards, missingStandardsForDiscipline } from "../office-standards/defaults.js";
import { buildAnalysisReport } from "../reporting/reportBuilder.js";
import { buildAnalysisWritePlanProposal } from "../tools/analysis_write_plan_proposal.js";

const hvacMissingStandards = missingStandardsForDiscipline("hvac", mergeOfficeStandards());
assert(hvacMissingStandards.includes("hvac.ductEqualFrictionTargetPaPerM"));
assert(hvacMissingStandards.includes("hvac.ductVelocityLimitsMps.main"));
assert(hvacMissingStandards.includes("hvac.ductVelocityLimitsMps.branch"));
assert(hvacMissingStandards.includes("hvac.ductVelocityLimitsMps.terminal"));
assert.deepEqual(missingStandardsForDiscipline("hvac", mergeOfficeStandards({
    hvac: {
        ductEqualFrictionTargetPaPerM: 1,
        ductVelocityLimitsMps: { main: 5, branch: 4, terminal: 2.5 },
    },
})), []);

const hydronicMissingStandards = missingStandardsForDiscipline("hydronic", mergeOfficeStandards());
assert(hydronicMissingStandards.includes("hydronic.pipeFrictionLimitPaPerM"));
assert(hydronicMissingStandards.includes("hydronic.pipeVelocityLimitsMps.main"));
assert(hydronicMissingStandards.includes("hydronic.pipeVelocityLimitsMps.branch"));

const domesticMissingStandards = missingStandardsForDiscipline("domestic_water", mergeOfficeStandards());
assert(domesticMissingStandards.includes("domesticWater.pressureLossMethod"));
assert(domesticMissingStandards.includes("domesticWater.fixtureUnitStandard"));

const sanitaryMissingStandards = missingStandardsForDiscipline("sanitary", mergeOfficeStandards());
assert(sanitaryMissingStandards.includes("sanitaryStorm.stackNodeIds"));
assert(sanitaryMissingStandards.includes("sanitaryStorm.ventNodeIds"));

const fireMissingStandards = missingStandardsForDiscipline("fire", mergeOfficeStandards());
assert(fireMissingStandards.includes("fire.simultaneousFireCabinetCount"));

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

const domesticDemand = convertFixtureUnitsToDemand({
    fixtureUnits: 16,
    demandCurve: [
        { fixtureUnits: 10, flowLs: 0.3 },
        { fixtureUnits: 20, flowLs: 0.45 },
    ],
});
assert.equal(domesticDemand.success, true);
assert(Math.abs(domesticDemand.output.demandFlowLs - 0.39) < 1e-12);

const domesticPressureLoss = calculateDomesticWaterPressureLoss({
    flowLs: 0.5,
    diameterMm: 25,
    lengthM: 10,
    staticLiftM: 3,
});
assert.equal(domesticPressureLoss.success, true);
assert(domesticPressureLoss.output.totalPressureLossPa > domesticPressureLoss.output.staticPressurePa);
assert(domesticPressureLoss.output.staticPressurePa > 29000);

const domesticPipeSizing = sizeDomesticWaterPipe({
    flowLs: 0.5,
    maxVelocityMps: 2.0,
    maxPressureLossPaPerM: 500,
    diametersMm: [15, 20, 25, 32],
});
assert.equal(domesticPipeSizing.success, true);
assert(domesticPipeSizing.selected.velocityMps <= 2.0);
assert(domesticPipeSizing.selected.pressureLossPaPerM <= 500);

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

const gravityPipeSize = sizeGravityPipeByFixtureUnits({
    fixtureUnits: 12,
    sizingTable: [
        { diameterMm: 50, maxFixtureUnits: 6, minSlopePercent: 2 },
        { diameterMm: 75, maxFixtureUnits: 20, minSlopePercent: 1 },
        { diameterMm: 100, maxFixtureUnits: 160, minSlopePercent: 1 },
    ],
});
assert.equal(gravityPipeSize.success, true);
assert.equal(gravityPipeSize.selected.diameterMm, 75);
assert.equal(sizeGravityPipeByFixtureUnits({ fixtureUnits: 12 }).requiresOfficeStandard, true);

const stormRunoff = calculateStormRunoffRational({
    catchmentAreaM2: 250,
    rainfallIntensityMmH: 120,
    runoffCoefficient: 0.9,
});
assert.equal(stormRunoff.success, true);
assert(Math.abs(stormRunoff.output.runoffFlowLs - 7.5) < 1e-12);
const stormPipeSize = sizeStormPipeByFlow({
    runoffFlowLs: stormRunoff.output.runoffFlowLs,
    sizingTable: [
        { diameterMm: 75, maxFlowLs: 5, minSlopePercent: 1 },
        { diameterMm: 100, maxFlowLs: 12, minSlopePercent: 1 },
    ],
});
assert.equal(stormPipeSize.success, true);
assert.equal(stormPipeSize.selected.diameterMm, 100);
assert.equal(calculateStormRunoffRational({ catchmentAreaM2: 250 }).requiresOfficeStandard, true);
assert.equal(sizeStormPipeByFlow({ runoffFlowLs: 7.5 }).requiresOfficeStandard, true);

const stackTrace = traceGravityDrainageToStack({
    fixtureNodeIds: ["wc-1", "lav-1"],
    stackNodeIds: ["stack-a"],
    edges: [
        { from: "wc-1", to: "branch-a" },
        { from: "lav-1", to: "branch-a" },
        { from: "branch-a", to: "stack-a" },
    ],
});
assert.equal(stackTrace.success, true);
assert.deepEqual(stackTrace.rows[0].pathNodeIds, ["wc-1", "branch-a", "stack-a"]);
const brokenStackTrace = traceGravityDrainageToStack({
    fixtureNodeIds: ["wc-1"],
    stackNodeIds: ["stack-a"],
    edges: [{ from: "wc-1", to: "branch-a" }],
});
assert.equal(brokenStackTrace.success, false);

const ventContinuity = checkVentContinuity({
    fixtureNodeIds: ["wc-1"],
    ventNodeIds: ["vent-a"],
    edges: [
        { from: "wc-1", to: "branch-a" },
        { from: "branch-a", to: "vent-a" },
    ],
});
assert.equal(ventContinuity.success, true);
assert.equal(checkVentContinuity({ fixtureNodeIds: ["wc-1"], edges: [] }).requiresOfficeStandard, true);

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

const cabinetCoverage = checkFireCabinetCoverage({
    cabinets: [{ x: 0, y: 0 }],
    targetPoints: [{ x: 20, y: 0 }, { x: 35, y: 0 }],
    maxHoseReachM: 30,
});
assert.equal(cabinetCoverage.success, false);
assert.equal(cabinetCoverage.issues[0].targetIndex, 1);

const cabinetDemand = calculateFireCabinetDemand({
    cabinetCount: 3,
    flowLpmPerCabinet: 100,
    simultaneousCabinetCount: 2,
});
assert.equal(cabinetDemand.success, true);
assert.equal(cabinetDemand.output.totalFlowLpm, 200);

const firePumpBasis = calculateFirePumpBasis({
    cabinetDemand,
    sprinklerDemandLpm: 300,
    residualPressureBar: 4,
    staticLiftM: 10,
    pipeLossKPa: 25,
    safetyFactor: 1.1,
});
assert.equal(firePumpBasis.success, true);
assert.equal(firePumpBasis.output.requiredFlowLpm, 500);
assert(Math.abs(firePumpBasis.output.requiredPressureKPa - 575.37315) < 1e-5);
assert.equal(calculateFireCabinetDemand({ cabinetCount: 1 }).requiresOfficeStandard, true);
assert.equal(calculateFirePumpBasis({ cabinetDemand }).requiresOfficeStandard, true);

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

const placementProposal = buildFamilyPlacementProposal({
    discipline: "hvac",
    placementKind: "air_terminal",
    defaultLevelId: 378117,
    requests: [
        {
            kind: "air_terminal",
            eId: "supply-air-terminal-001",
            familyName: "Supply Diffuser",
            typeName: "600x600",
            point: { x: 1, y: 2, z: 3 },
        },
        {
            kind: "damper",
            eId: "volume-damper-001",
            familySymbolId: 701,
            point: { x: 2, y: 2, z: 3 },
            levelId: 378118,
        },
    ],
});
assert.equal(placementProposal.success, true);
assert.equal(placementProposal.writePlanSteps.length, 2);
assert.equal(placementProposal.writePlanSteps[0].operation, "place_family_instance");
assert.equal(placementProposal.writePlanSteps[0].arguments.familyName, "Supply Diffuser");
assert.equal(placementProposal.writePlanSteps[0].arguments.levelId, 378117);
assert.equal(placementProposal.writePlanSteps[1].arguments.familySymbolId, 701);
assert.equal(placementProposal.writePlanSteps[1].arguments.levelId, 378118);
assert.equal(placementProposal.canCommit, false);

const invalidPlacementProposal = buildFamilyPlacementProposal({
    requests: [{ kind: "valve", point: { x: 0, y: 0, z: 0 } }],
});
assert.equal(invalidPlacementProposal.success, false);
assert(invalidPlacementProposal.errors[0].includes("familySymbolId or familyName/typeName"));

const hvacPlacementAnalysis = analyzeDomainPlacement({
    discipline: "hvac",
    defaultPlacementLevelId: 378117,
    placementRequests: [
        {
            kind: "air_terminal",
            eId: "supply-air-terminal-001",
            familyName: "Supply Diffuser",
            typeName: "600x600",
            point: { x: 1, y: 2, z: 3 },
        },
        {
            kind: "valve",
            eId: "isolation-valve-001",
            familySymbolId: 701,
            point: { x: 2, y: 2, z: 3 },
        },
    ],
});
assert.equal(hvacPlacementAnalysis.applicableRequestCount, 1);
assert.equal(hvacPlacementAnalysis.ignoredRequestCount, 1);
assert.equal(hvacPlacementAnalysis.placementProposal.writePlanSteps.length, 1);
assert.equal(hvacPlacementAnalysis.placementProposal.writePlanSteps[0].operation, "place_family_instance");
assert.equal(hvacPlacementAnalysis.placementProposal.writePlanSteps[0].eId, "supply-air-terminal-001");

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
const pressureMatchedLocalLossExtraction = summarizeLocalLossSamples({
    discipline: "hvac",
    criticalPathSelection: pressureCriticalPathSelection,
    samples: [
        {
            elementId: 40,
            category: "Duct Fittings",
            lossParameters: [
                { parameterName: "Pressure Drop", valueKind: "pressure_drop_pa", numericValue: 125 },
            ],
        },
    ],
});
assert.equal(pressureMatchedLocalLossExtraction.selectedPathPressureCheck.consistent, true);
assert.equal(pressureMatchedLocalLossExtraction.selectedPathPressureCheck.deltaPa, 0);
const pressureMismatchLocalLossExtraction = summarizeLocalLossSamples({
    discipline: "hvac",
    criticalPathSelection: pressureCriticalPathSelection,
    samples: [
        {
            elementId: 40,
            category: "Duct Fittings",
            lossParameters: [
                { parameterName: "Pressure Drop", valueKind: "pressure_drop_pa", numericValue: 50 },
            ],
        },
    ],
});
assert.equal(pressureMismatchLocalLossExtraction.selectedPathPressureCheck.consistent, false);
assert(pressureMismatchLocalLossExtraction.warnings.some((warning) => warning.includes("Selected path local-loss pressure check mismatch")));
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
                truncatedBySampleLimit: true,
                requestedTargetCount: 3,
                uninspectedTargetCount: 1,
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
assert.deepEqual(pathTargetingResult.warnings, [
    "Selected path local-loss read was truncated by sample limit (requested 3, uninspected 1).",
]);

const hydronicPathSizingCalls = [];
const hydronicPathSizing = await analyzeHydronic({
    officeStandards: {
        hydronic: {
            pipeVelocityLimitsMps: { main: 1.5 },
            pipeFrictionLimitPaPerM: 200,
        },
    },
    networkPathRequest: {
        localLossFromNetworkPath: true,
        rootElementId: 900,
        terminalElementIds: [901, 902],
        localLossSampleLimit: 2,
        hydraulicResistanceOnly: true,
    },
    executeRevitCodeFn: async (code, options) => {
        hydronicPathSizingCalls.push({ code, options });
        if (hydronicPathSizingCalls.length === 1) {
            return {
                result: {
                    connectorPathfinding: {
                        terminalPaths: [
                            { elementId: 901, reachable: true, hopCount: 2, pathElementIds: [900, 1001, 901] },
                            { elementId: 902, reachable: true, hopCount: 2, pathElementIds: [900, 2001, 902] },
                        ],
                    },
                },
            };
        }
        if (hydronicPathSizingCalls.length === 2) {
            assert(hydronicPathSizingCalls[1].code.includes("int[] targetElementIds = new int[] { 900, 1001, 901, 2001, 902 }"));
            return {
                result: {
                    localLossSamples: [
                        {
                            elementId: 900,
                            category: "Pipe Fittings",
                            systemName: "Hydronic Supply",
                            lossParameters: [
                                { parameterName: "Pressure Drop", valueKind: "pressure_drop_pa", numericValue: 125 },
                            ],
                        },
                    ],
                },
            };
        }
        if (hydronicPathSizingCalls.length === 3) {
            assert(hydronicPathSizingCalls[2].code.includes("int[] targetElementIds = new int[] { 900, 1001, 901 }"));
            return {
                result: {
                    localLossSamples: [
                        {
                            elementId: 900,
                            category: "Pipe Fittings",
                            systemName: "Hydronic Supply",
                            lossParameters: [
                                { parameterName: "Pressure Drop", valueKind: "pressure_drop_pa", numericValue: 125 },
                            ],
                        },
                    ],
                },
            };
        }
        assert(hydronicPathSizingCalls[3].code.includes("pipeResistanceSamples"));
        assert(hydronicPathSizingCalls[3].code.includes("designFlowLs"));
        assert(hydronicPathSizingCalls[3].code.includes("flowDisplay"));
        return {
            result: {
                hydraulicResistanceOnly: true,
                inspectedPipeCount: 1,
                pipeResistanceSamples: [
                    { elementId: 1001, uniqueId: "pipe-1001", systemName: "Hydronic Supply", lengthM: 4, diameterMm: 32, designFlowLs: 1.0, flowDisplay: "1.0 L/s" },
                ],
            },
        };
    },
});
assert.equal(hydronicPathSizingCalls.length, 4);
assert.deepEqual(hydronicPathSizingCalls.map((call) => call.options), [
    { transactionMode: "none" },
    { transactionMode: "none" },
    { transactionMode: "none" },
    { transactionMode: "none" },
]);
assert.equal(hydronicPathSizing.localLossExtraction.targetedByCriticalPath, true);
assert.equal(hydronicPathSizing.localLossExtraction.selectedPathPressureCheck.consistent, true);
assert.equal(hydronicPathSizing.pipeSizingProposal.success, true);
assert.equal(hydronicPathSizing.pipeSizingProposal.localLossContext.complete, true);
assert.equal(hydronicPathSizing.pipeSizingProposal.rows[0].elementId, 1001);
assert.equal(hydronicPathSizing.pipeSizingProposal.rows[0].criticalPathLocalLossPressurePa, 125);
assert.equal(hydronicPathSizing.pipeSizingProposal.writePlanSteps[0].operation, "resize_pipe");
assert.equal(hydronicPathSizing.pipeSizingProposal.writePlanSteps[0].targets.elementId, 1001);
assert.equal(hydronicPathSizing.revitRead.pipeSizingRead.pipeResistanceSamples.length, 1);

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

const hvacDuctSizingCalls = [];
const hvacDuctSizing = await analyzeHvacAirside({
    officeStandards: {
        hvac: {
            ductEqualFrictionTargetPaPerM: 1.0,
            ductVelocityLimitsMps: { main: 5.0 },
        },
    },
    networkPathRequest: {
        ductSizingOnly: true,
        ductSizingSampleLimit: 1,
        criticalPathLocalLossPressurePa: 50,
        criticalPathLocalLossComplete: true,
    },
    executeRevitCodeFn: async (code, options) => {
        hvacDuctSizingCalls.push({ code, options });
        assert(code.includes("ductSizingOnly = true"));
        assert(code.includes("designFlowM3h"));
        assert(code.includes("flowDisplay"));
        return {
            result: {
                ductSizingOnly: true,
                inspectedDuctCount: 1,
                ductSamples: [
                    { elementId: 201, uniqueId: "duct-201", systemName: "Supply Air", lengthM: 8, widthMm: 300, heightMm: 300, designFlowM3h: 1800, flowDisplay: "500.0 L/s" },
                ],
            },
        };
    },
});
assert.equal(hvacDuctSizingCalls.length, 1);
assert.deepEqual(hvacDuctSizingCalls[0].options, { transactionMode: "none" });
assert.equal(hvacDuctSizing.ductSizingProposal.success, true);
assert.equal(hvacDuctSizing.ductSizingProposal.localLossContext.complete, true);
assert.equal(hvacDuctSizing.ductSizingProposal.rows[0].elementId, 201);
assert.equal(hvacDuctSizing.ductSizingProposal.rows[0].criticalPathLocalLossPressurePa, 50);
assert.equal(hvacDuctSizing.ductSizingProposal.writePlanSteps[0].operation, "resize_duct");
assert.equal(hvacDuctSizing.revitRead.ductSamples.length, 1);

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
            ductSizingProposal: {
                status: "proposal_ready_for_review",
                rows: [
                    {
                        rowType: "hvac_duct_sizing_proposal",
                        elementId: 201,
                        uniqueId: "duct-201",
                        systemName: "Supply Air",
                        lengthM: 8,
                        designFlowM3h: 1800,
                        currentWidthMm: 300,
                        currentHeightMm: 300,
                        selectedWidthMm: 400,
                        selectedHeightMm: 400,
                        selectedVelocityMps: 3.125,
                        selectedPressureLossPaPerM: 0.8,
                        selectedLinearPressureLossPa: 6.4,
                        criticalPathLocalLossPressurePa: 50,
                        localLossDatasetComplete: true,
                        resizeRequired: true,
                        status: "proposal_ready_for_review",
                    },
                ],
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
            pipeSizingProposal: {
                status: "proposal_ready_for_review",
                rows: [
                    {
                        rowType: "hydronic_pipe_sizing_proposal",
                        elementId: 101,
                        uniqueId: "u-101",
                        systemName: "Hydronic Supply",
                        lengthM: 4,
                        designFlowLs: 1,
                        currentDiameterMm: 32,
                        selectedDiameterMm: 50,
                        selectedVelocityMps: 0.5,
                        selectedPressureLossPaPerM: 61,
                        selectedLinearPressureLossPa: 244,
                        criticalPathLocalLossPressurePa: 2500,
                        localLossDatasetComplete: true,
                        resizeRequired: true,
                        status: "proposal_ready_for_review",
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
assert.equal(report.pipeSizingRows.length, 1);
assert.equal(report.ductSizingRows.length, 1);
assert.equal(report.localLossRows.length, 2);
assert.equal(report.localLossPressureRows.length, 3);
assert(report.issueCsv.includes("missing_standard"));
assert(report.designLogCsv.includes("weighted graph shortest path traversal"));
assert(report.boqCsv.includes("Total duct length"));
assert(report.boqCsv.includes("Supply Air"));
assert(report.hydraulicResistanceCsv.includes("Hydronic Supply"));
assert(report.pipeSizingCsv.includes("hydronic_pipe_sizing_proposal"));
assert(report.pipeSizingCsv.includes("proposal_ready_for_review"));
assert(report.ductSizingCsv.includes("hvac_duct_sizing_proposal"));
assert(report.ductSizingCsv.includes("proposal_ready_for_review"));
assert(report.localLossCsv.includes("Pressure Drop"));
assert(report.localLossPressureCsv.includes("local_loss_pressure_total"));
assert.equal(report.canCommit, false);

const selectedPathReport = buildAnalysisReport({
    analyses: [
        {
            discipline: "hvac",
            engine: "hvac-airside-foundation",
            localLossExtraction: pressureMatchedLocalLossExtraction,
        },
    ],
    delimiter: ";",
});
assert(selectedPathReport.localLossPressureRows.some((row) => row.rowType === "local_loss_selected_path_pressure_check"));
assert(selectedPathReport.localLossPressureCsv.includes("local_loss_selected_path_pressure_check"));
assert(selectedPathReport.localLossPressureCsv.includes("125"));

const writePlanProposal = buildAnalysisWritePlanProposal({
    discipline: "all",
    analyses: [
        {
            discipline: "hvac",
            ductSizingProposal: {
                writePlanSteps: [
                    {
                        stepId: "resize-duct-201",
                        operation: "resize_duct",
                        dependsOn: [],
                        targets: { elementId: 201 },
                        arguments: { width: 400, height: 400, unit: "mm" },
                        preconditions: ["HVAC sizing proposal reviewed."],
                        riskLevel: "medium",
                    },
                ],
            },
        },
        {
            discipline: "hydronic",
            pipeSizingProposal: {
                writePlanSteps: [
                    {
                        stepId: "resize-pipe-101",
                        operation: "resize_pipe",
                        dependsOn: [],
                        targets: { elementId: 101 },
                        arguments: { diameter: 50, unit: "mm" },
                        preconditions: ["Hydronic sizing proposal reviewed."],
                        riskLevel: "medium",
                    },
                ],
            },
        },
        {
            discipline: "general",
            placementProposal,
        },
    ],
});
assert.equal(writePlanProposal.success, true);
assert.equal(writePlanProposal.stepCount, 4);
assert.deepEqual(writePlanProposal.operations, ["resize_duct", "resize_pipe", "place_family_instance"]);
assert.equal(writePlanProposal.plan.discipline, "general");
assert.equal(writePlanProposal.plan.riskLevel, "medium");
assert.equal(writePlanProposal.plan.steps[0].operation, "resize_duct");
assert.equal(writePlanProposal.plan.steps[1].operation, "resize_pipe");
assert.equal(writePlanProposal.plan.steps[2].operation, "place_family_instance");
assert(writePlanProposal.plan.steps[0].preconditions.some((text) => text.includes("preview before commit")));
assert.equal(writePlanProposal.validation.valid, true);
assert.equal(writePlanProposal.canCommit, false);

const invalidWritePlanProposal = buildAnalysisWritePlanProposal({
    discipline: "general",
    analyses: [
        {
            discipline: "general",
            placementProposal: invalidPlacementProposal,
        },
    ],
});
assert.equal(invalidWritePlanProposal.success, false);
assert(invalidWritePlanProposal.validation.errors[0].includes("familySymbolId or familyName/typeName"));

console.log("domain foundation calculation tests passed");
