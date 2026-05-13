import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFirePipingTopologyAudit } from "./fireTopologyAudit.js";

const repoRoot = path.resolve(process.cwd(), "..", "..");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "fire-piping");

function loadFixture(name: string) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function findingCodes(report: any) {
    return report.findings.map((finding: any) => finding.code);
}

function node(report: any, nodeId: string) {
    const found = report.nodes.find((item: any) => item.nodeId === nodeId);
    assert.ok(found, `Expected node '${nodeId}' in audit report.`);
    return found;
}

function sizing(report: any, nodeId: string) {
    const found = report.sizingAudit.find((item: any) => item.nodeId === nodeId);
    assert.ok(found, `Expected sizing audit for '${nodeId}'.`);
    return found;
}

const tree = createFirePipingTopologyAudit(loadFixture("single-riser-tree.json"));
assert.equal(tree.reportLabel, "audit/schematic");
assert.equal(tree.hydraulicApproval, false);
assert.equal(tree.summary.sourceCount, 1);
assert.equal(tree.summary.sprinklerCount, 4);
assert.equal(tree.summary.cabinetCount, 0);
assert.equal(node(tree, "pipe-main").downstreamSprinklerCount, 4);
assert.equal(node(tree, "pipe-branch-a").downstreamSprinklerCount, 2);
assert.equal(sizing(tree, "pipe-main").status, "ok");
assert.equal(tree.missingHydraulicInputs.length, 0);
assert.ok(tree.reducerReport.transitions.some((item: any) => item.status === "reducer_present"));
assert.ok(!findingCodes(tree).includes("missing_control_valve"));
assert.equal(tree.solverAdapter.status, "schematic_ready_for_solver_mapping");

const cabinet = createFirePipingTopologyAudit(loadFixture("cabinet-branch.json"));
assert.equal(cabinet.summary.cabinetCount, 1);
assert.equal(node(cabinet, "pipe-main").downstreamCabinetCount, 1);
assert.equal(sizing(cabinet, "pipe-cabinet").status, "undersized_schematic");
assert.ok(findingCodes(cabinet).includes("missing_reducer_between_pipe_segments"));
assert.equal(cabinet.solverAdapter.status, "schematic_ready_for_solver_mapping");

const loop = createFirePipingTopologyAudit(loadFixture("looped-grid.json"));
assert.equal(loop.summary.cycleDetected, true);
assert.equal(loop.summary.sprinklerCount, 2);
assert.ok(findingCodes(loop).includes("cycle_detected"));
assert.ok(findingCodes(loop).includes("edge_orientation_tie"));
assert.equal(node(loop, "pipe-a").downstreamSprinklerCount, 2);

const isolated = createFirePipingTopologyAudit(loadFixture("isolated-sprinkler.json"));
assert.equal(isolated.summary.openEndCount, 1);
assert.ok(findingCodes(isolated).includes("no_source_found"));
assert.ok(findingCodes(isolated).includes("isolated_terminal"));
assert.ok(findingCodes(isolated).includes("open_end"));
assert.ok(findingCodes(isolated).includes("missing_k_factor"));
assert.equal(isolated.solverAdapter.status, "not_ready_missing_hydraulic_inputs");

const missingValve = createFirePipingTopologyAudit(loadFixture("missing-valve.json"));
assert.ok(findingCodes(missingValve).includes("missing_control_valve"));
assert.ok(findingCodes(missingValve).includes("missing_design_density"));
assert.ok(findingCodes(missingValve).includes("missing_k_factor"));
assert.ok(findingCodes(missingValve).includes("missing_c_factor"));
assert.ok(findingCodes(missingValve).includes("missing_equivalent_length"));
assert.equal(sizing(missingValve, "pipe-1").status, "ok");

const disconnected = createFirePipingTopologyAudit(loadFixture("disconnected-network.json"));
assert.equal(disconnected.summary.componentCount, 2);
assert.ok(findingCodes(disconnected).includes("disconnected_network"));
assert.ok(findingCodes(disconnected).includes("terminal_component_without_source"));
assert.ok(findingCodes(disconnected).includes("edge_unreached_from_source"));
assert.equal(node(disconnected, "pipe-fed").downstreamSprinklerCount, 1);

console.error("fire piping topology audit tests passed");
