import assert from "node:assert/strict";
import {
    ductFrictionLossPaPerM,
    ductVelocityMps,
    rectangularDuctAreaM2,
    rectangularHydraulicDiameterM,
    sizeRectangularDuctEqualFriction,
} from "./hvac/calculations.js";
import {
    circularAreaM2,
    pipeFrictionLossPaPerM,
    pipeVelocityMps,
    sizePipeByVelocityOrFriction,
} from "./hydronic/calculations.js";

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

console.log("engineering calculation tests passed");
