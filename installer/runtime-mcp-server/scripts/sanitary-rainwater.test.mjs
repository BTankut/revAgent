import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  calculateSanitaryRainwater,
  createWriteBackPlan,
} from "../build/calculations/sanitary-rainwater/calculator.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(scriptDir, "../../../tests/fixtures/sanitary-rainwater");

async function readFixture(name) {
  const text = await readFile(path.join(fixtureRoot, name), "utf8");
  return JSON.parse(text);
}

function recommendation(report, nodeId) {
  const item = report.recommendations.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(item, `Missing recommendation for ${nodeId}`);
  return item;
}

const sanitary = calculateSanitaryRainwater(await readFixture("sanitary-branch-to-stack.json"));
assert.equal(sanitary.status, "warn");
assert.equal(sanitary.summary.blockerCount, 0);

const mainBranch = recommendation(sanitary, "pipe-main-branch");
assert.equal(mainBranch.accumulatedFixtureUnits, 6);
assert.equal(mainBranch.requiredDiameterMm, 50);
assert.equal(mainBranch.recommendedDiameterMm, 75);
assert.equal(mainBranch.noReductionRaisedFromMm, 50);

const buildingDrain = recommendation(sanitary, "building-drain-1");
assert.equal(buildingDrain.accumulatedFixtureUnits, 6);
assert.equal(buildingDrain.recommendedDiameterMm, 75);
assert.equal(buildingDrain.requiresDiameterChange, true);

const sanitaryPlan = createWriteBackPlan(sanitary);
assert.equal(sanitaryPlan.status, "ready");
assert.ok(sanitaryPlan.changes.some((change) => change.nodeId === "pipe-main-branch" && change.targetDiameterMm === 75));
assert.ok(sanitaryPlan.changes.some((change) => change.nodeId === "building-drain-1" && change.targetDiameterMm === 75));

const disconnectedSource = await readFixture("sanitary-branch-to-stack.json");
disconnectedSource.edges = disconnectedSource.edges.filter((edge) => edge.id !== "edge-lav-pipe");
const disconnectedSourceReport = calculateSanitaryRainwater(disconnectedSource);
assert.equal(disconnectedSourceReport.status, "fail");
assert.ok(disconnectedSourceReport.findings.some((finding) => finding.code === "disconnected_source_load" && finding.nodeIds.includes("lav-1")));
assert.equal(createWriteBackPlan(disconnectedSourceReport).status, "blocked");

const rainwater = calculateSanitaryRainwater(await readFixture("rainwater-leader.json"));
assert.equal(rainwater.status, "warn");
assert.equal(rainwater.summary.blockerCount, 0);

const leader = recommendation(rainwater, "leader-1");
assert.equal(leader.accumulatedFlowLps, 9.5);
assert.equal(leader.orientation, "vertical");
assert.equal(leader.recommendedDiameterMm, 75);
assert.equal(leader.requiresDiameterChange, false);

const stormMain = recommendation(rainwater, "storm-main-1");
assert.equal(stormMain.accumulatedFlowLps, 9.5);
assert.equal(stormMain.orientation, "horizontal");
assert.equal(stormMain.requiredDiameterMm, 100);
assert.equal(stormMain.recommendedDiameterMm, 100);
assert.equal(stormMain.requiresDiameterChange, true);
assert.ok(rainwater.foundationFeedback.some((item) => item.code === "storm_load_inputs"));

const rainPlan = createWriteBackPlan(rainwater);
assert.equal(rainPlan.status, "ready");
assert.deepEqual(rainPlan.changes.map((change) => change.nodeId), ["storm-main-1"]);

const ambiguous = calculateSanitaryRainwater(await readFixture("ambiguous-direction.json"));
assert.equal(ambiguous.status, "fail");
assert.ok(ambiguous.findings.some((finding) => finding.code === "direction_ambiguous"));
assert.equal(createWriteBackPlan(ambiguous).status, "blocked");

console.error("sanitary/rainwater calculation tests passed");
