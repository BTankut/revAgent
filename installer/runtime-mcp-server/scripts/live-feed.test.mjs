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
  assert.equal(status.writeHealth.dropped, 0);

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
