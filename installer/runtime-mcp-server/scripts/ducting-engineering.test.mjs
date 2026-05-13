import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateDuctingProduction } from "../build/engineering/ducting/index.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ducting");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
}

function runFixture(name) {
  return evaluateDuctingProduction(loadFixture(name));
}

function hasIssue(report, code, severity) {
  return report.issues.some((issue) => issue.code === code && (!severity || issue.severity === severity));
}

const good = runFixture("good-room");
assert.equal(good.summary.status, "pass");
assert.equal(good.diffuserPlans[0].candidates.length, 2);
assert.equal(good.routePreview.status, "pass");
assert.equal(good.connectedNetwork.status, "pass");
assert.equal(good.nativeSizingValidation.status, "pass");

const noAirflow = runFixture("room-no-airflow");
assert.equal(hasIssue(noAirflow, "room_no_airflow", "warning"), true);
assert.equal(noAirflow.diffuserPlans[0].candidates.length, 0);

const tooMuchAirflow = runFixture("too-much-airflow");
assert.equal(hasIssue(tooMuchAirflow, "diffuser_flow_exceeds_catalog", "error"), true);

const noType = runFixture("no-valid-diffuser-type");
assert.equal(hasIssue(noType, "no_valid_diffuser_type", "error"), true);

const blockedPlenum = runFixture("blocked-plenum");
assert.equal(hasIssue(blockedPlenum, "plenum_blocked", "error"), true);

const disconnectedGraph = runFixture("disconnected-duct-graph");
assert.equal(hasIssue(disconnectedGraph, "duct_graph_disconnected", "error"), true);

console.error("ducting engineering tests passed");
