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
process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT = "16";
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

  const guardedTask = telemetry.recordLiveActivityStarted({
    scope: "mcp.tool",
    toolName: "inspect_sheet_text",
    taskName: "Runtime guarded sheet search",
    taskId: "guarded-task-1",
    parentTaskName: "Operator live feedback audit",
    parentTaskId: "operator-parent-1",
    params: {
      textQuery: "PIPING",
      taskName: "Runtime guarded sheet search",
    },
  });

  telemetry.recordLiveActivityFinished(guardedTask, {
    responseSummary: {
      success: true,
      guarded: true,
      guardSource: "client",
      state: "guarded",
      action: "inspect_sheet_text",
      errorMessage: "needs_scope",
    },
    durationMs: 7,
  });

  await telemetry.flushLiveWritesForTests();

  const runtimeActivity = telemetry.getLiveRuntimeActivityStatus(10);
  const runtimeGuardedActivity = runtimeActivity.recentActivity.find((item) => item.taskName === "Runtime guarded sheet search" && item.phase === "guarded");
  assert.equal(Boolean(runtimeGuardedActivity), true);
  assert.equal(runtimeGuardedActivity.guardSource, "client");
  assert.equal(runtimeGuardedActivity.parentTaskName, "Operator live feedback audit");
  assert.equal(runtimeGuardedActivity.parentTaskIdPresent, true);

  telemetry.recordLiveRevitStatus({
    activeTask: null,
    recentTasks: [
      {
        id: "status-1",
        requestId: "request-1",
        method: "send_code_to_revit",
        wrapperAction: "set_schedule_cells_by_text",
        logicalToolName: "set_schedule_cells_by_text",
        taskName: "Status window aligned task",
        parentTaskName: "Wrapper schedule edit",
        parentTaskId: "wrapper-parent-1",
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
  const guardedActivity = status.recentActivity.find((item) => item.taskName === "Runtime guarded sheet search" && item.phase === "guarded");
  assert.equal(Boolean(guardedActivity), true);
  assert.equal(guardedActivity.guardSource, "client");
  assert.equal(guardedActivity.parentTaskName, "Operator live feedback audit");
  assert.equal(guardedActivity.parentTaskIdPresent, true);
  assert.equal(guardedActivity.result.guardSource, "client");
  assert.equal(status.revitStatus.recentTasks[0].taskName, "Status window aligned task");
  assert.equal(status.revitStatus.recentTasks[0].wrapperAction, "set_schedule_cells_by_text");
  assert.equal(status.revitStatus.recentTasks[0].logicalToolName, "set_schedule_cells_by_text");
  assert.equal(status.revitStatus.recentTasks[0].parentTaskName, "Wrapper schedule edit");
  assert.equal(status.revitStatus.recentTasks[0].parentTaskIdPresent, true);
  assert.equal(status.revitStatus.recentTasks[0].state, "failed");
  assert.equal(status.revitStatus.recentTasks[0].responseBytes, 222);
  assert.equal(status.writeHealth.dropped, 0);

  telemetry.recordLiveRevitStatus({
    activeTask: null,
    recentTasks: [
      {
        id: null,
        requestId: "request-1",
        method: "send_code_to_revit",
        taskName: "Status window aligned task",
        state: "running",
        startedAtUtc: "2026-05-31T12:00:00.000Z",
        finishedAtUtc: null,
        elapsedMs: null,
        requestBytes: null,
        responseBytes: null,
        error: null,
      },
      {
        id: "status-2",
        requestId: "request-2",
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
      {
        method: "send_code_to_revit",
        taskName: "Fallback lifecycle task",
        state: "running",
        startedAtUtc: "2026-05-31T12:00:04.000Z",
        finishedAtUtc: null,
        elapsedMs: null,
        requestBytes: 555,
        responseBytes: null,
        error: null,
      },
      {
        method: "send_code_to_revit",
        taskName: "Fallback lifecycle task",
        state: "completed",
        startedAtUtc: "2026-05-31T12:00:04.000Z",
        finishedAtUtc: "2026-05-31T12:00:05.000Z",
        elapsedMs: 1000,
        requestBytes: 555,
        responseBytes: 666,
        error: null,
      },
    ],
    recentHistoryCount: 1,
    recentHistoryCapacity: 100,
  });
  await telemetry.flushLiveWritesForTests();

  const mergedStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.ok(
    mergedStatus.revitStatus.recentTasks.some((item) => item.taskName === "Status window aligned task" && item.id === "status-1" && item.state === "failed" && item.responseBytes === 222),
    "Existing Revit status history must survive another live session snapshot.",
  );
  assert.ok(
    mergedStatus.revitStatus.recentTasks.some((item) => item.taskName === "Status window aligned task" && item.wrapperAction === "set_schedule_cells_by_text" && item.parentTaskName === "Wrapper schedule edit"),
    "Merged Revit status history must preserve wrapper action and parent task metadata.",
  );
  assert.ok(
    mergedStatus.revitStatus.recentTasks.some((item) => item.taskName === "Other live dashboard session" && item.responseBytes === 444),
    "New Revit status history from the current snapshot must still be included.",
  );
  const fallbackLifecycleTasks = mergedStatus.revitStatus.recentTasks.filter((item) => item.taskName === "Fallback lifecycle task");
  assert.equal(fallbackLifecycleTasks.length, 1);
  assert.equal(fallbackLifecycleTasks[0].state, "completed");
  assert.equal(fallbackLifecycleTasks[0].responseBytes, 666);

  const lines = fs.readFileSync(activityPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].schemaVersion, "revagent.live.activity.v1");
  assert.equal(lines[0].phase, "started");
  assert.ok(lines.some((line) => line.phase === "completed" && line.durationMs === 123));
  const guardedLine = lines.find((line) => line.phase === "guarded" && line.taskName === "Runtime guarded sheet search");
  assert.equal(Boolean(guardedLine), true);
  assert.equal(guardedLine.guardSource, "client");
  assert.equal(guardedLine.parentTaskName, "Operator live feedback audit");
  assert.equal(guardedLine.parentTaskIdPresent, true);

  const localStatusPath = path.join(localRoot, "live", "machines", "LIVE-TEST", "status.json");
  assert.ok(fs.existsSync(localStatusPath), "Local live status mirror was not written.");

  console.log("live feed tests passed");
}
finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
