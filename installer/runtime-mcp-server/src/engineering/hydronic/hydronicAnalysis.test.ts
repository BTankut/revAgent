import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    analyzeHydronicPipingGraph,
    calculateDarcyWeisbachPressureDropPa,
    calculateHazenWilliamsPressureDropPa,
    calculateVelocityMps,
    equivalentLengthFromK,
} from "./hydronicAnalysis.js";

function fixture(name: string) {
    const url = new URL(`../../../src/engineering/hydronic/fixtures/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf8"));
}

function missingFields(report: any) {
    return report.graph_audit.missing_data.map((item: any) => item.field);
}

function segment(report: any, id: string) {
    const match = report.segments.find((item: any) => item.id === id);
    assert(match, `Missing segment ${id}`);
    return match;
}

const velocity = calculateVelocityMps(2, 0.05);
assert(Math.abs(velocity - 1.0186) < 0.001, `Unexpected velocity: ${velocity}`);

const darcy = calculateDarcyWeisbachPressureDropPa({
    flowLps: 2,
    diameterM: 0.05,
    lengthM: 10,
    roughnessMm: 0.0015,
    densityKgM3: 998.2,
    dynamicViscosityPaS: 0.001002,
});
assert(darcy.pressureDropPa > 1900 && darcy.pressureDropPa < 2600, `Darcy pressure out of range: ${darcy.pressureDropPa}`);
assert(darcy.reynoldsNumber > 50000 && darcy.reynoldsNumber < 51000, `Unexpected Reynolds number: ${darcy.reynoldsNumber}`);
assert(darcy.frictionFactor > 0.019 && darcy.frictionFactor < 0.023, `Unexpected friction factor: ${darcy.frictionFactor}`);

const darcyWithLocalLoss = calculateDarcyWeisbachPressureDropPa({
    flowLps: 2,
    diameterM: 0.05,
    lengthM: 10,
    kValue: 2,
});
assert(darcyWithLocalLoss.pressureDropPa > darcy.pressureDropPa, "K value should add local pressure loss.");
assert.equal(Math.round(equivalentLengthFromK(2, 0.05, 0.02)), 5);

const hazen = calculateHazenWilliamsPressureDropPa({
    flowLps: 2,
    diameterM: 0.05,
    lengthM: 10,
    hazenWilliamsC: 140,
});
assert(hazen.pressureDropPa > 0, "Hazen-Williams pressure drop should be positive.");
assert(hazen.pressureDropPaPerM > 0, "Hazen-Williams pressure loss per meter should be positive.");

const singleLoop = analyzeHydronicPipingGraph(fixture("single-loop"));
assert.equal(singleLoop.success, true);
assert.equal(singleLoop.summary.directed_cycle_count, 1);
assert.equal(singleLoop.critical_path.kind, "closed_loop");
assert(singleLoop.summary.pump_head_m > 0, "Pump head should be available for single loop.");
assert.equal(singleLoop.dry_run, true);

const branchLoop = analyzeHydronicPipingGraph(fixture("branch-loop"));
assert.equal(branchLoop.success, true);
assert.equal(branchLoop.critical_path.terminal_node_id, "COIL_B");
const coilAReport = branchLoop.balancing_valve_report.find((item: any) => item.terminal_node_id === "COIL_A");
assert(coilAReport.required_balancing_delta_pa > 0, "Shorter branch should require balancing delta-P.");
assert.deepEqual(coilAReport.balancing_valve_node_ids, ["BV_A"]);

const reorderedBranchLoopFixture = fixture("branch-loop");
reorderedBranchLoopFixture.nodes = [
    reorderedBranchLoopFixture.nodes.find((node: any) => node.id === "COIL_A"),
    ...reorderedBranchLoopFixture.nodes.filter((node: any) => node.id !== "COIL_A"),
];
const reorderedBranchLoop = analyzeHydronicPipingGraph(reorderedBranchLoopFixture);
assert.equal(segment(reorderedBranchLoop, "S_MAIN").flow_lps, segment(branchLoop, "S_MAIN").flow_lps);
assert.equal(segment(reorderedBranchLoop, "R_MAIN").flow_lps, segment(branchLoop, "R_MAIN").flow_lps);
assert.equal(reorderedBranchLoop.summary.pump_head_pressure_pa, branchLoop.summary.pump_head_pressure_pa);

const missingFlow = analyzeHydronicPipingGraph(fixture("missing-flow"));
assert.equal(missingFlow.status, "needs_review");
assert(missingFields(missingFlow).includes("flow_lps"));

const missingDiameter = analyzeHydronicPipingGraph(fixture("missing-diameter"));
assert.equal(missingDiameter.status, "needs_review");
assert(missingFields(missingDiameter).includes("diameter"));

const reversed = analyzeHydronicPipingGraph(fixture("reversed-direction"));
assert.equal(reversed.critical_path, null);
assert(reversed.warnings.some((warning: string) => warning.includes("Possible reversed graph direction")));

const disconnected = analyzeHydronicPipingGraph(fixture("disconnected-network"));
assert.equal(disconnected.summary.disconnected_network_count, 1);
assert(disconnected.graph_audit.components.length === 2);

console.log("hydronic piping analysis tests passed");
