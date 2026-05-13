import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  auditDcwDhwGraph,
  convertFixtureUnitsToFlow,
  DEFAULT_FIXTURE_UNIT_TABLES,
} from "../build/engineering/dcw-dhw/sizingAudit.js";
import {
  createWriteBackCode,
  validateWriteBackApproval,
  WRITEBACK_CONFIRM_TEXT,
} from "../build/engineering/dcw-dhw/writeBack.js";

const fixtureRoot = path.resolve(process.cwd(), "../../tests/fixtures/dcw-dhw");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function findingCodes(report) {
  return new Set(report.missingDataReport.findings.map((finding) => finding.code));
}

const interpolated = convertFixtureUnitsToFlow(7, DEFAULT_FIXTURE_UNIT_TABLES.mixed);
assert.equal(interpolated.interpolation, "linear");
assert.equal(interpolated.ruleId, "project-default-mixed-fu-to-flow-v1:6-8");
assert.equal(interpolated.flowLps, 0.485);

const mixedReport = auditDcwDhwGraph(loadFixture("tank-valve-mixed.json"), {
  diameterCatalogMm: [15, 20, 25, 32, 40],
  maxVelocityMps: { dcw: 2.0, dhw: 1.5, dhwr: 1.0 },
  parameterWriteBack: {
    includeDesignFlowParameter: true,
    includeFixtureUnitsParameter: true,
  },
});
assert.equal(mixedReport.status, "ok");
assert.equal(mixedReport.summary.fixtureCount, 4);
assert.equal(mixedReport.summary.dcwPipeCount, 1);
assert.equal(mixedReport.summary.dhwPipeCount, 1);

const coldMain = mixedReport.sizing.find((result) => result.nodeId === "pipe-cw-main");
assert.equal(coldMain.fixtureUnits, 13.5);
assert.equal(coldMain.flushValveFixtureUnits, 10);
assert.equal(coldMain.flowTableId, "project-default-flush-valve-fu-to-flow-v1");
assert.equal(coldMain.proposedDiameterMm, 25);
assert.deepEqual(coldMain.downstreamFixtureNodeIds, ["lav-cold", "wc-tank", "wc-valve"]);

assert.ok(mixedReport.writeBackPlan.actionCount >= 3);
assert.match(mixedReport.writeBackPlan.approvalToken, /^[a-f0-9]{64}$/);
const approved = validateWriteBackApproval(
  mixedReport.writeBackPlan.actions,
  mixedReport.writeBackPlan.approvalToken,
  WRITEBACK_CONFIRM_TEXT,
);
assert.equal(approved.ok, true);
const rejected = validateWriteBackApproval(
  mixedReport.writeBackPlan.actions,
  "bad-token",
  WRITEBACK_CONFIRM_TEXT,
);
assert.equal(rejected.ok, false);

const writeCode = createWriteBackCode(mixedReport.writeBackPlan.actions);
assert.match(writeCode, /RBS_PIPE_DIAMETER_PARAM/);
assert.doesNotMatch(writeCode, /new\s+Autodesk\.Revit\.DB\.Transaction/);

const disconnectedReport = auditDcwDhwGraph(loadFixture("disconnected-branch.json"));
const disconnectedCodes = findingCodes(disconnectedReport);
assert.equal(disconnectedReport.status, "warning");
assert.ok(disconnectedCodes.has("fixture_units_missing"));
assert.ok(disconnectedCodes.has("zero_flow_section"));
assert.ok(disconnectedCodes.has("open_end"));
assert.ok(disconnectedCodes.has("disconnected_island"));

const recircReport = auditDcwDhwGraph(loadFixture("dhwr-loop.json"), {
  dhwrDeltaTC: 5,
});
const recircCodes = findingCodes(recircReport);
assert.equal(recircReport.status, "warning");
assert.ok(recircCodes.has("dhwr_cycle_limited"));
assert.equal(recircReport.dhwRecirculation.totalHeatLossW, 180);
assert.equal(recircReport.dhwRecirculation.criticalPath.heatLossW, 180);
assert.ok(Math.abs(recircReport.dhwRecirculation.totalReturnFlowLps - 0.00863) < 0.00001);

console.log("DCW/DHW sizing audit tests passed");
