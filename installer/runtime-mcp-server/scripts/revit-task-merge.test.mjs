import assert from "node:assert/strict";
import {
  coalesceTaskField,
  mergeRecentRevitTasks,
  mergeRevitTask,
  revitTaskKey,
  unexpiredCachedRevitStatus,
} from "../build/utils/revitTaskMerge.js";

const startedAtUtc = "2026-06-04T10:00:00.000Z";
const finishedAtUtc = "2026-06-04T10:00:05.000Z";

function task(overrides = {}) {
  return {
    method: "send_code_to_revit",
    taskName: "Matrix task",
    startedAtUtc,
    ...overrides,
  };
}

{
  const running = task({ state: "running", requestBytes: 100, finishedAtUtc: null, elapsedMs: null });
  const completed = task({ state: "completed", finishedAtUtc, elapsedMs: 5000, responseBytes: 200, error: "stale error" });
  const merged = mergeRevitTask(running, completed);
  assert.equal(merged.state, "completed");
  assert.equal(merged.finishedAtUtc, finishedAtUtc);
  assert.equal(merged.elapsedMs, 5000);
  assert.equal(merged.error, null);
  assert.equal(merged.responseBytes, 200);
}

{
  const completed = task({ state: "completed", finishedAtUtc, elapsedMs: 5000, responseBytes: 200 });
  const running = task({ state: "running", finishedAtUtc: "2026-06-04T10:01:00.000Z", elapsedMs: 60000, responseBytes: null });
  const merged = mergeRevitTask(completed, running);
  assert.equal(merged.state, "completed");
  assert.equal(merged.finishedAtUtc, finishedAtUtc);
  assert.equal(merged.elapsedMs, 5000);
  assert.equal(merged.responseBytes, 200);
}

{
  const completed = task({ state: "completed", finishedAtUtc, elapsedMs: 5000, error: "must clear" });
  const failed = task({ state: "failed", finishedAtUtc: "2026-06-04T10:00:06.000Z", elapsedMs: 6000, error: "boom" });
  const completedThenFailed = mergeRevitTask(completed, failed);
  assert.equal(completedThenFailed.state, "failed");
  assert.equal(completedThenFailed.error, "boom");

  const failedThenCompleted = mergeRevitTask(failed, completed);
  assert.equal(failedThenCompleted.state, "completed");
  assert.equal(failedThenCompleted.error, null);
  assert.equal(failedThenCompleted.finishedAtUtc, finishedAtUtc);
}

{
  const guarded = task({ state: "guarded", finishedAtUtc, elapsedMs: 5000, error: "guard text" });
  const failed = task({ state: "failed", finishedAtUtc: "2026-06-04T10:00:06.000Z", elapsedMs: 6000, error: "boom" });
  const merged = mergeRevitTask(guarded, failed);
  assert.equal(merged.state, "failed");
  assert.equal(merged.finishedAtUtc, "2026-06-04T10:00:06.000Z");
  assert.equal(merged.elapsedMs, 6000);
  assert.equal(merged.error, "boom");
}

{
  const guarded = task({ state: "guarded", finishedAtUtc, elapsedMs: 5000, error: "guard text" });
  const blocked = task({ state: "blocked", finishedAtUtc: "2026-06-04T10:01:00.000Z", elapsedMs: 60000, error: "blocked text" });
  const merged = mergeRevitTask(guarded, blocked);
  assert.equal(merged.state, "guarded");
  assert.equal(merged.finishedAtUtc, finishedAtUtc);
  assert.equal(merged.elapsedMs, 5000);
  assert.equal(merged.error, null);
}

{
  const runningA = task({ state: "running", finishedAtUtc: "2026-06-04T10:01:00.000Z", elapsedMs: 60000 });
  const runningB = task({ state: "running", responseBytes: 300 });
  const merged = mergeRevitTask(runningA, runningB);
  assert.equal(merged.state, "running");
  assert.equal(merged.finishedAtUtc, null);
  assert.equal(merged.elapsedMs, null);
  assert.equal(merged.responseBytes, 300);
}

{
  const cached = task({ id: "status-1", requestId: "request-1", state: "completed", responseBytes: 200 });
  const current = task({ id: null, requestId: null, state: "completed", responseBytes: null });
  const merged = mergeRevitTask(cached, current);
  assert.equal(merged.id, "status-1");
  assert.equal(merged.requestId, "request-1");
  assert.equal(merged.responseBytes, 200);
}

{
  const running = task({ state: "running", finishedAtUtc: null, elapsedMs: null });
  const completed = task({ state: "completed", finishedAtUtc, elapsedMs: 5000 });
  assert.equal(revitTaskKey(running), revitTaskKey(completed));

  const rows = mergeRecentRevitTasks([completed], [running], 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].finishedAtUtc, finishedAtUtc);
}

{
  const cachedEntry = { cachedAtMs: 1000, revitStatus: { recentTasks: [task({ state: "completed" })] } };
  assert.equal(unexpiredCachedRevitStatus(cachedEntry, 1500, 1000), cachedEntry.revitStatus);
  assert.equal(unexpiredCachedRevitStatus(cachedEntry, 2501, 1000), null);
}

{
  assert.equal(coalesceTaskField({ responseBytes: null }, { responseBytes: 42 }, "responseBytes"), 42);
  assert.equal(coalesceTaskField({ responseBytes: 99 }, { responseBytes: 42 }, "responseBytes"), 99);
}

console.log("revit task merge matrix tests passed");
