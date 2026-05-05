import assert from "node:assert/strict";
import {
    ductFrictionLossPaPerM,
    ductVelocityMps,
    calculateFanPressureBasis,
    rectangularDuctAreaM2,
    rectangularHydraulicDiameterM,
    sizeRectangularDuctEqualFriction,
} from "./hvac/calculations.js";
import {
    calculatePumpHeadBasis,
    circularAreaM2,
    pipeFrictionLossPaPerM,
    pipeVelocityMps,
    sizePipeByVelocityOrFriction,
} from "./hydronic/calculations.js";
import {
    analyzeTreeNetwork,
    analyzeWeightedNetwork,
    exampleAirsideWeightedNetwork,
    exampleAirsideTreeNetwork,
    exampleHydronicWeightedNetwork,
    exampleHydronicTreeNetwork,
} from "./network/calculations.js";

function close(actual, expected, tolerance, label) {
    assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

close(rectangularDuctAreaM2(500, 500), 0.25, 1e-9, "duct area");
close(rectangularHydraulicDiameterM(500, 500), 0.5, 1e-9, "duct hydraulic diameter");
close(ductVelocityMps(3600, 500, 500), 4.0, 1e-9, "duct velocity");

const ductLoss = ductFrictionLossPaPerM(3600, 500, 500);
assert.equal(ductLoss.success, true);
close(ductLoss.output.pressureLossPaPerM, 0.45, 0.12, "duct friction loss hand check");
assert(ductLoss.output.reynolds > 100000, "duct Reynolds should be turbulent");

const ductSize = sizeRectangularDuctEqualFriction({
    flowM3h: 3600,
    targetPaPerM: 1.0,
    maxVelocityMps: 5.0,
});
assert.equal(ductSize.success, true);
assert(ductSize.selected.velocityMps <= 5.0);
assert(ductSize.selected.pressureLossPaPerM <= 1.0);
assert.equal(ductSize.canCommit, false);

const ductMissingStandards = sizeRectangularDuctEqualFriction({
    flowM3h: 3600,
    targetPaPerM: null,
    maxVelocityMps: null,
});
assert.equal(ductMissingStandards.success, false);
assert.equal(ductMissingStandards.requiresOfficeStandard, true);
assert.deepEqual(ductMissingStandards.missingStandards, [
    "hvac.ductEqualFrictionTargetPaPerM",
    "hvac.ductVelocityLimitsMps",
]);

close(circularAreaM2(50), 0.0019634954, 1e-9, "pipe area");
close(pipeVelocityMps(1.0, 50), 0.5092958, 1e-6, "pipe velocity");

const pipeLoss = pipeFrictionLossPaPerM(1.0, 50);
assert.equal(pipeLoss.success, true);
close(pipeLoss.output.pressureLossPaPerM, 61.0, 12.0, "pipe friction loss hand check");
assert(pipeLoss.output.reynolds > 20000, "pipe Reynolds should be turbulent");

const pipeSize = sizePipeByVelocityOrFriction({
    flowLs: 1.0,
    maxVelocityMps: 1.0,
    maxPressureLossPaPerM: 120.0,
});
assert.equal(pipeSize.success, true);
assert(pipeSize.selected.velocityMps <= 1.0);
assert(pipeSize.selected.pressureLossPaPerM <= 120.0);
assert.equal(pipeSize.canCommit, false);

const pipeMissingStandards = sizePipeByVelocityOrFriction({
    flowLs: 1.0,
    maxVelocityMps: null,
    maxPressureLossPaPerM: null,
});
assert.equal(pipeMissingStandards.success, false);
assert.equal(pipeMissingStandards.requiresOfficeStandard, true);
assert.deepEqual(pipeMissingStandards.missingStandards, [
    "hydronic.pipeVelocityLimitsMps",
    "hydronic.pipeFrictionLimitPaPerM",
]);

const airNetwork = exampleAirsideTreeNetwork();
assert.equal(airNetwork.success, true);
assert.equal(airNetwork.isTree, true);
assert.equal(airNetwork.totalDemand, 400);
assert.deepEqual(airNetwork.criticalPath.nodeIds, ["fan", "main", "branch-b", "term-b"]);
close(airNetwork.criticalPath.totalLossPa, 112, 1e-9, "airside critical path loss");
const airBranch = airNetwork.branchFlows.find((branch) => branch.from === "fan" && branch.to === "main");
assert.equal(airBranch.flow, 400);

const weightedAirNetwork = exampleAirsideWeightedNetwork();
assert.equal(weightedAirNetwork.success, true);
assert.equal(weightedAirNetwork.componentCount, 1);
assert.deepEqual(weightedAirNetwork.criticalPath.nodeIds, ["fan", "main", "branch-b", "term-b"]);
close(weightedAirNetwork.criticalPath.totalLossPa, 112, 1e-9, "weighted airside critical path loss");

const fanBasis = calculateFanPressureBasis({
    network: {
        rootNodeId: "fan",
        edges: [
            { from: "fan", to: "main", pressureLossPa: 35 },
            { from: "main", to: "term-a", pressureLossPa: 58 },
            { from: "main", to: "term-b", pressureLossPa: 77 },
        ],
        terminalDemands: { "term-a": 180, "term-b": 220 },
    },
    equipmentLossPa: 80,
    terminalAllowancePa: 40,
    safetyFactor: 1.1,
});
assert.equal(fanBasis.success, true);
assert.equal(fanBasis.output.requiredFlowM3h, 400);
close(fanBasis.output.requiredPressurePa, 255.2, 1e-9, "fan pressure basis");

const hydronicNetwork = exampleHydronicTreeNetwork();
assert.equal(hydronicNetwork.success, true);
assert.equal(hydronicNetwork.isTree, true);
close(hydronicNetwork.totalDemand, 0.77, 1e-9, "hydronic total branch flow");
assert.deepEqual(hydronicNetwork.criticalPath.nodeIds, ["pump", "riser", "coil-b"]);
close(hydronicNetwork.criticalPath.totalLossPa, 4300, 1e-9, "hydronic critical circuit loss");

const weightedHydronicNetwork = exampleHydronicWeightedNetwork();
assert.equal(weightedHydronicNetwork.success, true);
assert.equal(weightedHydronicNetwork.cycleDetected, true);
assert.deepEqual(weightedHydronicNetwork.criticalPath.nodeIds, ["pump", "riser", "coil-b"]);
close(weightedHydronicNetwork.criticalPath.totalLossPa, 4300, 1e-9, "weighted hydronic critical circuit loss");

const pumpBasis = calculatePumpHeadBasis({
    network: {
        rootNodeId: "pump",
        edges: [
            { from: "pump", to: "riser", pressureLossPa: 1200 },
            { from: "riser", to: "coil-a", pressureLossPa: 2400 },
            { from: "riser", to: "coil-b", pressureLossPa: 3100 },
        ],
        terminalDemands: { "coil-a": 0.35, "coil-b": 0.42 },
    },
    equipmentLossKPa: 12,
    terminalLossKPa: 8,
    safetyFactor: 1.1,
});
assert.equal(pumpBasis.success, true);
close(pumpBasis.output.requiredFlowLs, 0.77, 1e-9, "pump basis flow");
close(pumpBasis.output.requiredHeadKPa, 26.73, 1e-9, "pump head basis");

const cyclicNetwork = analyzeTreeNetwork({
    rootNodeId: "a",
    edges: [
        { from: "a", to: "b", pressureLossPa: 1 },
        { from: "b", to: "c", pressureLossPa: 1 },
        { from: "c", to: "a", pressureLossPa: 1 },
    ],
    terminalDemands: { c: 1 },
});
assert.equal(cyclicNetwork.success, true);
assert.equal(cyclicNetwork.isTree, false);
assert(cyclicNetwork.warnings.some((warning) => warning.includes("cycles")));

const disconnectedWeighted = analyzeWeightedNetwork({
    rootNodeId: "source",
    edges: [
        { from: "source", to: "a", pressureLossPa: 1 },
        { from: "orphan", to: "terminal", pressureLossPa: 1 },
    ],
    terminalNodeIds: ["terminal"],
});
assert.equal(disconnectedWeighted.success, true);
assert.equal(disconnectedWeighted.terminalPaths[0].reachable, false);
assert(disconnectedWeighted.warnings.some((warning) => warning.includes("disconnected")));

console.log("engineering calculation tests passed");
