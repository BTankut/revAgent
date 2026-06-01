import assert from "node:assert/strict";
import { runtimeFailure, runtimeGuarded, runtimeSuccess } from "../build/utils/runtimeResult.js";

const success = runtimeSuccess({
  action: "unit_test_success",
  notices: [" created "],
  extra: { count: 2 },
});
assert.equal(success.success, true);
assert.equal(success.guarded, false);
assert.equal(success.state, "completed");
assert.equal(success.action, "unit_test_success");
assert.deepEqual(success.notices, ["created"]);
assert.equal(success.count, 2);

const guardedWithConflictingExtra = runtimeGuarded({
  action: "unit_test_reserved_keys",
  error: "protected",
  reason: "reserved_key_guard",
  extra: {
    success: true,
    guarded: false,
    state: "completed",
    action: "wrong_action",
    error: "wrong_error",
    reason: "wrong_reason",
    warnings: ["wrong_warning"],
    notices: ["wrong_notice"],
    count: 3,
  },
});
assert.equal(guardedWithConflictingExtra.success, false);
assert.equal(guardedWithConflictingExtra.guarded, true);
assert.equal(guardedWithConflictingExtra.state, "guarded");
assert.equal(guardedWithConflictingExtra.action, "unit_test_reserved_keys");
assert.equal(guardedWithConflictingExtra.error, "protected");
assert.equal(guardedWithConflictingExtra.reason, "reserved_key_guard");
assert.equal(guardedWithConflictingExtra.warnings, undefined);
assert.equal(guardedWithConflictingExtra.notices, undefined);
assert.equal(guardedWithConflictingExtra.count, 3);

const guarded = runtimeGuarded({
  action: "unit_test_guard",
  reason: "manual_transaction_requires_transactionMode_none",
  error: " Guarded by safety. ",
  warnings: ["", " check target "],
});
assert.equal(guarded.success, false);
assert.equal(guarded.guarded, true);
assert.equal(guarded.state, "guarded");
assert.equal(guarded.reason, "manual_transaction_requires_transactionMode_none");
assert.equal(guarded.error, "Guarded by safety.");
assert.deepEqual(guarded.warnings, ["check target"]);

const failed = runtimeFailure({
  action: "unit_test_failure",
  error: "socket unavailable",
});
assert.equal(failed.success, false);
assert.equal(failed.guarded, false);
assert.equal(failed.state, "failed");
assert.equal(failed.error, "socket unavailable");

console.log("runtime result contract tests passed");
