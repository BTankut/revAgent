import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-live-feed-"));
const reportsRoot = path.join(tempRoot, "reports");
const localRoot = path.join(tempRoot, "local-telemetry");

process.env.REVAGENT_REPORTS_ROOT = reportsRoot;
process.env.REVAGENT_TELEMETRY_ROOT = localRoot;
process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS = "0";
process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT = "8";
process.env.COMPUTERNAME = "LIVE-TEST";
process.env.USERNAME = "TESTUSER";

try {
  const telemetry = await import("../build/utils/telemetry.js");

  const task = telemetry.recordLiveActivityStarted({
    scope: "mcp.tool",
    toolName: "find_elements",
    taskName: "Find live dashboard ducts",
    params: {
      taskName: "Find live dashboard ducts",
      category: "Ducts",
    },
  });

  assert.ok(task?.liveTaskId, "Live task id was not returned.");

  telemetry.recordLiveActivityFinished(task, {
    responseSummary: {
      success: true,
      guarded: false,
      state: "completed",
    },
    durationMs: 123,
  });

  await telemetry.flushLiveWritesForTests();

  telemetry.recordLiveRevitStatus({
    activeTask: null,
    recentTasks: [
      {
        id: "status-1",
        method: "send_code_to_revit",
        taskName: "Status window aligned task",
        state: "failed",
        startedAtUtc: "2026-05-31T12:00:00.000Z",
        finishedAtUtc: "2026-05-31T12:00:01.000Z",
        elapsedMs: 1000,
        requestBytes: 111,
        responseBytes: 222,
        error: "status failure",
      },
    ],
    recentHistoryCount: 1,
    recentHistoryCapacity: 100,
  });

  await telemetry.flushLiveWritesForTests();

  const statusPath = path.join(reportsRoot, "live", "machines", "LIVE-TEST", "status.json");
  const activityPath = path.join(reportsRoot, "live", "machines", "LIVE-TEST", "activity", new Date().toISOString().slice(0, 10) + ".ndjson");
  assert.ok(fs.existsSync(statusPath), "Remote live status.json was not written.");
  assert.ok(fs.existsSync(activityPath), "Remote live activity file was not written.");

  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.schemaVersion, "revagent.live.status.v1");
  assert.equal(status.machineName, "LIVE-TEST");
  assert.equal(status.userName, "TESTUSER");
  assert.equal(status.activeTask, null);
  assert.ok(Array.isArray(status.activeTasks));
  assert.equal(status.activeTasks.length, 0);
  assert.ok(Array.isArray(status.recentActivity));
  assert.ok(status.recentActivity.some((item) => item.taskName === "Find live dashboard ducts" && item.phase === "completed"));
  assert.equal(status.revitStatus.recentTasks[0].taskName, "Status window aligned task");
  assert.equal(status.revitStatus.recentTasks[0].state, "failed");
  assert.equal(status.revitStatus.recentTasks[0].responseBytes, 222);
  assert.equal(status.writeHealth.dropped, 0);

  telemetry.recordLiveRevitStatus({
    activeTask: null,
    recentTasks: [
      {
        id: "status-2",
        method: "send_code_to_revit",
        taskName: "Other live dashboard session",
        state: "completed",
        startedAtUtc: "2026-05-31T12:00:02.000Z",
        finishedAtUtc: "2026-05-31T12:00:03.000Z",
        elapsedMs: 1000,
        requestBytes: 333,
        responseBytes: 444,
        error: null,
      },
    ],
    recentHistoryCount: 1,
    recentHistoryCapacity: 100,
  });
  await telemetry.flushLiveWritesForTests();

  const mergedStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.ok(
    mergedStatus.revitStatus.recentTasks.some((item) => item.taskName === "Status window aligned task" && item.responseBytes === 222),
    "Existing Revit status history must survive another live session snapshot.",
  );
  assert.ok(
    mergedStatus.revitStatus.recentTasks.some((item) => item.taskName === "Other live dashboard session" && item.responseBytes === 444),
    "New Revit status history from the current snapshot must still be included.",
  );

  const lines = fs.readFileSync(activityPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].schemaVersion, "revagent.live.activity.v1");
  assert.equal(lines[0].phase, "started");
  assert.equal(lines[1].phase, "completed");
  assert.equal(lines[1].durationMs, 123);

  const localStatusPath = path.join(localRoot, "live", "machines", "LIVE-TEST", "status.json");
  assert.ok(fs.existsSync(localStatusPath), "Local live status mirror was not written.");

  console.log("live feed tests passed");
}
finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
