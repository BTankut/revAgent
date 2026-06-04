import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDashboardBrief, loadDashboardData } from "./server.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-dashboard-smoke-"));
const releaseRoot = path.join(tempRoot, "release");
const reportsRoot = path.join(releaseRoot, "reports");
const version = "2026.05.31.198-3c28b632";
const now = new Date();
const todayUtc = now.toISOString().slice(0, 10);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function appendNdjson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

try {
  writeJson(path.join(releaseRoot, "channels", "stable.json"), {
    schemaVersion: 1,
    app: "revit-mcp-skill",
    channel: "stable",
    version,
    git: {
      commit: "3c28b632",
    },
  });

  writeJson(path.join(reportsRoot, "machines", "TESTPC", "latest.json"), {
    schemaVersion: "revagent.machine-report.v1",
    computerName: "TESTPC",
    userName: "BT",
    atUtc: now.toISOString(),
    status: "updated",
    operation: "update",
    operationMethod: "fast-package",
    installedVersion: version,
    targetVersion: version,
    diagnostics: {
      fastPackageOnlyUpdate: true,
      revitPayloadChanged: false,
      deferredForRevitClose: false,
    },
    machineReport: {
      logPath: "\\\\nas\\reports\\machines\\TESTPC\\logs\\update.log",
    },
  });

  writeJson(path.join(reportsRoot, "machines", "OLDPC", "latest.json"), {
    schemaVersion: "revagent.machine-report.v1",
    computerName: "OLDPC",
    userName: "Old",
    atUtc: now.toISOString(),
    status: "updated",
    operation: "update",
    operationMethod: "old-channel",
    installedVersion: "2026.05.31.100-oldbuild",
    targetVersion: "2026.05.31.100-oldbuild",
    diagnostics: {
      fastPackageOnlyUpdate: true,
      revitPayloadChanged: false,
      deferredForRevitClose: false,
    },
  });

  writeJson(path.join(reportsRoot, "machines", "CLOSEDPC", "latest.json"), {
    schemaVersion: "revagent.machine-report.v1",
    computerName: "CLOSEDPC",
    userName: "Closed",
    atUtc: now.toISOString(),
    status: "updated",
    operation: "update",
    operationMethod: "old-channel",
    installedVersion: "2026.05.31.100-oldbuild",
    targetVersion: "2026.05.31.100-oldbuild",
    diagnostics: {
      fastPackageOnlyUpdate: true,
      revitPayloadChanged: false,
      deferredForRevitClose: false,
    },
  });

  writeJson(path.join(reportsRoot, "live", "machines", "TESTPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "TESTPC",
    userName: "BT",
    lastHeartbeatUtc: now.toISOString(),
    runtime: {
      version,
    },
    activeTask: {
      toolName: "inspect_elements",
      taskName: "smoke inspect",
      startedAtUtc: now.toISOString(),
    },
    activeTasks: [],
    recentActivity: [],
    revitStatus: {
      activeTask: null,
      recentTasks: [
        {
          id: "status-cleanup",
          method: "send_code_to_revit",
          taskName: "smoke status cleanup",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 7000).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 7200).toISOString(),
          elapsedMs: 200,
          requestBytes: 1700,
          responseBytes: 2600,
          error: null,
        },
        {
          id: "status-schedule-guidance",
          method: "export_revit_view_image",
          taskName: "smoke schedule guidance",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 5010).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 5580).toISOString(),
          elapsedMs: 570,
          requestBytes: 1900,
          responseBytes: 4200,
          error: null,
        },
        {
          id: "status-semantic-guard",
          method: "send_code_to_revit",
          taskName: "smoke semantic guard",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 6010).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 6080).toISOString(),
          elapsedMs: 70,
          requestBytes: 800,
          responseBytes: 1200,
          error: null,
        },
        {
          id: "status-inspect-schedules",
          requestId: "request-inspect-schedules",
          method: "send_code_to_revit",
          taskName: "smoke inspect schedules",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 6500).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 6580).toISOString(),
          elapsedMs: 80,
          requestBytes: 900,
          responseBytes: 1800,
          error: null,
        },
      ],
      recentHistoryCount: 4,
      recentHistoryCapacity: 100,
    },
    writeHealth: {
      droppedCount: 0,
    },
  });

  writeJson(path.join(reportsRoot, "live", "machines", "OLDPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "OLDPC",
    userName: "Old",
    lastHeartbeatUtc: new Date(now.getTime() - 120000).toISOString(),
    runtime: {
      version: "2026.05.31.100-oldbuild",
    },
    activeTask: null,
    activeTasks: [],
    recentActivity: [],
  });

  writeJson(path.join(reportsRoot, "live", "machines", "CLOSEDPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "CLOSEDPC",
    userName: "Closed",
    lastHeartbeatUtc: new Date(now.getTime() - 600000).toISOString(),
    runtime: {
      version: "2026.05.31.100-oldbuild",
    },
    activeTask: null,
    activeTasks: [],
    recentActivity: [],
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-inspect",
    phase: "started",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "inspect_elements",
    taskName: "smoke inspect",
    timestampUtc: now.toISOString(),
    params: {
      code: {
        preview: "x".repeat(12000),
      },
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-failure",
    phase: "failed",
    state: "failed",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "send_code_to_revit_safe",
    taskName: "smoke guarded-looking failure",
    timestampUtc: new Date(now.getTime() + 2000).toISOString(),
    durationMs: 1,
    result: {
      success: false,
      guarded: false,
      errorMessage: "smoke failure",
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-guarded",
    phase: "guarded",
    state: "guarded",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "send_code_to_revit_safe",
    taskName: "smoke guarded write",
    timestampUtc: new Date(now.getTime() + 3000).toISOString(),
    durationMs: 1,
    result: {
      success: false,
      guarded: true,
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-command-only-selection",
    phase: "completed",
    state: "completed",
    scope: "revit.command",
    machineName: "TESTPC",
    commandName: "get_selected_elements",
    logicalToolName: "get_selected_elements",
    taskName: "smoke command-only selection",
    timestampUtc: new Date(now.getTime() + 3500).toISOString(),
    durationMs: 50,
    result: {
      success: true,
      guarded: false,
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-inspect",
    phase: "completed",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "inspect_elements",
    taskName: "smoke inspect",
    timestampUtc: new Date(now.getTime() + 1000).toISOString(),
    durationMs: 1000,
    params: {
      code: {
        preview: "y".repeat(12000),
      },
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-sheet-export-tool",
    phase: "completed",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "export_revit_view_image",
    taskName: "smoke sheet export",
    startedAtUtc: new Date(now.getTime() + 4000).toISOString(),
    timestampUtc: new Date(now.getTime() + 4500).toISOString(),
    durationMs: 500,
    result: {
      success: true,
      guarded: false,
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-sheet-export-inner",
    phase: "completed",
    scope: "revit.command",
    machineName: "TESTPC",
    commandName: "send_code_to_revit",
    taskName: "smoke sheet export",
    startedAtUtc: new Date(now.getTime() + 4010).toISOString(),
    timestampUtc: new Date(now.getTime() + 4490).toISOString(),
    durationMs: 480,
    result: {
      success: true,
      guarded: false,
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-schedule-guidance-tool",
    phase: "failed",
    state: "failed",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "export_revit_view_image",
    taskName: "smoke schedule guidance",
    startedAtUtc: new Date(now.getTime() + 5000).toISOString(),
    timestampUtc: new Date(now.getTime() + 5600).toISOString(),
    durationMs: 600,
    result: {
      success: false,
      guarded: false,
      errorMessage: "unsupported_view_type_for_image_export",
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-schedule-guidance-inner",
    phase: "failed",
    state: "failed",
    scope: "revit.command",
    machineName: "TESTPC",
    commandName: "send_code_to_revit",
    taskName: "smoke schedule guidance",
    startedAtUtc: new Date(now.getTime() + 5010).toISOString(),
    timestampUtc: new Date(now.getTime() + 5580).toISOString(),
    durationMs: 570,
    result: {
      success: false,
      guarded: false,
      errorMessage: "unsupported_view_type_for_image_export",
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-semantic-guard-tool",
    phase: "guarded",
    state: "guarded",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "set_element_parameter",
    taskName: "smoke semantic guard",
    startedAtUtc: new Date(now.getTime() + 6000).toISOString(),
    timestampUtc: new Date(now.getTime() + 6090).toISOString(),
    durationMs: 90,
    result: {
      success: false,
      guarded: true,
      errorMessage: "read_only_parameter_blocked",
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-inspect-schedules-tool",
    phase: "completed",
    scope: "mcp.tool",
    machineName: "TESTPC",
    toolName: "inspect_schedules",
    taskName: "smoke inspect schedules",
    startedAtUtc: new Date(now.getTime() + 6500).toISOString(),
    timestampUtc: new Date(now.getTime() + 6590).toISOString(),
    durationMs: 90,
    result: {
      success: true,
      guarded: false,
      action: "inspect_schedules",
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    liveTaskId: "smoke-inspect-schedules-inner",
    phase: "completed",
    scope: "revit.command",
    machineName: "TESTPC",
    commandName: "send_code_to_revit",
    logicalToolName: "inspect_schedules",
    taskName: "smoke inspect schedules",
    startedAtUtc: new Date(now.getTime() + 6510).toISOString(),
    timestampUtc: new Date(now.getTime() + 6570).toISOString(),
    durationMs: 60,
    result: {
      success: true,
      guarded: false,
      action: "inspect_schedules",
    },
  });

  writeJson(path.join(reportsRoot, "summaries", "latest.json"), {
    schemaVersion: "revagent.usage.summary.v1",
    dateUtc: todayUtc,
    source: {
      eventCount: 9,
    },
    totals: {
      sessionCount: 1,
    },
    production: {
      operationCount: 2,
    },
    sendCode: {
      count: 0,
    },
    toolUsage: [
      {
        name: "inspect_elements",
        count: 2,
        successCount: 2,
        guardedCount: 0,
        failedCount: 0,
        averageDurationMs: 500,
      },
    ],
    friction: {
      guarded: [],
      failed: [],
      slow: [],
    },
  });

  writeJson(path.join(reportsRoot, "summaries", "publish-latest.json"), {
    schemaVersion: "revagent.usage.publish.v1",
    latestDateUtc: todayUtc,
  });

  const data = loadDashboardData({
    reportsRoot,
    releaseRoot,
    staleSeconds: 60,
    offlineSeconds: 300,
    activityLimit: 20,
  });

  assert.equal(data.schemaVersion, "revagent.dashboard.snapshot.v1");
  assert.equal(data.stable.version, version);
  assert.equal(data.overview.machineCount, 3);
  assert.equal(data.overview.liveMachineCount, 1);
  assert.equal(data.overview.activeMachineCount, 1);
  assert.equal(data.overview.currentVersionCount, 1);
  assert.equal(data.overview.staleMachineCount, 1);
  assert.equal(data.overview.offlineMachineCount, 1);
  assert.equal(data.overview.productionOperationCount, 9);
  assert.equal(data.overview.liveOperationCount, 9);
  assert.equal(data.overview.liveCompletedCount, 7);
  assert.equal(data.overview.guardedCount, 1);
  assert.equal(data.overview.failedCount, 1);
  assert.equal(data.overview.summaryProductionOperationCount, 2);
  assert.equal(data.overview.metricSource, "liveActivity");
  const testMachine = data.machines.find((machine) => machine.machine === "TESTPC");
  const oldMachine = data.machines.find((machine) => machine.machine === "OLDPC");
  const closedMachine = data.machines.find((machine) => machine.machine === "CLOSEDPC");
  assert.equal(testMachine.state, "active");
  assert.equal(testMachine.connectionState, "online");
  assert.equal(testMachine.versionState, "upToDate");
  assert.equal(testMachine.taskState, "running");
  assert.equal(testMachine.versionCurrent, true);
  assert.equal(testMachine.live.activeTask.taskName, "smoke inspect");
  assert.equal(testMachine.live.recentActivity[0].taskName, "smoke status cleanup");
  assert.equal(testMachine.live.recentActivity[0].phase, "completed");
  assert.equal(oldMachine.state, "outdated");
  assert.equal(oldMachine.connectionState, "stale");
  assert.equal(oldMachine.versionCurrent, false);
  assert.equal(oldMachine.targetVersion, version);
  assert.equal(oldMachine.reportedTargetVersion, "2026.05.31.100-oldbuild");
  assert.equal(closedMachine.connectionState, "offline");
  assert.equal(data.activity.length, 9);
  assert.equal(data.activity[0].taskName, "smoke status cleanup");
  assert.equal(data.activity[0].phase, "completed");
  assert.equal(data.activity[0].toolName, "send_code_to_revit");
  assert.equal(data.activity[0].requestBytes, 1700);
  assert.equal(data.activity[0].responseBytes, 2600);
  assert.equal(data.activity.filter((event) => event.taskName === "smoke sheet export").length, 1);
  assert.equal(data.activity.find((event) => event.taskName === "smoke sheet export").toolName, "export_revit_view_image");
  assert.equal(data.activity.filter((event) => event.taskName === "smoke schedule guidance").length, 1);
  assert.equal(data.activity.find((event) => event.taskName === "smoke schedule guidance").source, "revit.status");
  assert.equal(data.activity.filter((event) => event.taskName === "smoke semantic guard").length, 1);
  assert.equal(data.activity.find((event) => event.taskName === "smoke semantic guard").phase, "completed");
  assert.equal(data.activity.find((event) => event.taskName === "smoke semantic guard").toolName, "set_element_parameter");
  assert.equal(data.activity.filter((event) => event.taskName === "smoke inspect schedules").length, 1);
  assert.equal(data.activity.find((event) => event.taskName === "smoke inspect schedules").toolName, "inspect_schedules");
  assert.equal(data.activity.find((event) => event.taskName === "smoke inspect schedules").source, "revit.status+telemetry");
  assert.equal(data.activity.find((event) => event.taskName === "smoke inspect schedules").requestBytes, 900);
  assert.equal(data.activity.find((event) => event.taskName === "smoke command-only selection").toolName, "get_selected_elements");

  writeJson(path.join(reportsRoot, "live", "machines", "TESTPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "TESTPC",
    userName: "BT",
    lastHeartbeatUtc: new Date(now.getTime() + 9000).toISOString(),
    runtime: {
      version,
    },
    activeTask: null,
    activeTasks: [],
    recentActivity: [],
    revitStatus: {
      activeTask: null,
      recentTasks: [
        {
          id: "status-other-session",
          method: "send_code_to_revit",
          taskName: "smoke other session task",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 7200).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 7300).toISOString(),
          elapsedMs: 100,
          requestBytes: 700,
          responseBytes: 800,
          error: null,
        },
        {
          id: null,
          requestId: "request-inspect-schedules",
          method: "send_code_to_revit",
          taskName: "smoke inspect schedules",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 6500).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 6580).toISOString(),
          elapsedMs: null,
          requestBytes: null,
          responseBytes: null,
          error: null,
        },
        {
          method: "send_code_to_revit",
          taskName: "smoke fallback lifecycle",
          state: "running",
          startedAtUtc: new Date(now.getTime() + 7400).toISOString(),
          finishedAtUtc: null,
          elapsedMs: null,
          requestBytes: 300,
          responseBytes: null,
          error: null,
        },
        {
          method: "send_code_to_revit",
          taskName: "smoke fallback lifecycle",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 7400).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 7520).toISOString(),
          elapsedMs: 120,
          requestBytes: 300,
          responseBytes: 1200,
          error: null,
        },
      ],
      recentHistoryCount: 1,
      recentHistoryCapacity: 100,
    },
    writeHealth: {
      droppedCount: 0,
    },
  });
  const mergedStatusData = loadDashboardData({
    reportsRoot,
    releaseRoot,
    staleSeconds: 60,
    offlineSeconds: 300,
    activityLimit: 20,
  });
  const mergedInspectSchedules = mergedStatusData.activity.find((event) => event.taskName === "smoke inspect schedules");
  assert.equal(mergedInspectSchedules.toolName, "inspect_schedules");
  assert.equal(mergedInspectSchedules.source, "revit.status+telemetry");
  assert.equal(mergedInspectSchedules.eventId, "status-inspect-schedules");
  assert.equal(mergedInspectSchedules.requestBytes, 900);
  assert.equal(mergedInspectSchedules.responseBytes, 1800);
  const fallbackLifecycleRows = mergedStatusData.activity.filter((event) => event.taskName === "smoke fallback lifecycle");
  assert.equal(fallbackLifecycleRows.length, 1);
  assert.equal(fallbackLifecycleRows[0].phase, "completed");
  assert.equal(fallbackLifecycleRows[0].responseBytes, 1200);

  writeJson(path.join(reportsRoot, "live", "machines", "TESTPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "TESTPC",
    userName: "BT",
    lastHeartbeatUtc: new Date(now.getTime() + 10000).toISOString(),
    runtime: {
      version,
    },
    activeTask: null,
    activeTasks: [],
    recentActivity: [],
    revitStatus: null,
    writeHealth: {
      droppedCount: 0,
    },
  });
  const cachedStatusData = loadDashboardData({
    reportsRoot,
    releaseRoot,
    staleSeconds: 60,
    offlineSeconds: 300,
    activityLimit: 20,
  });
  assert.equal(cachedStatusData.activity.find((event) => event.taskName === "smoke inspect schedules").toolName, "inspect_schedules");
  assert.equal(cachedStatusData.activity.find((event) => event.taskName === "smoke inspect schedules").source, "revit.status+telemetry");
  assert.equal(cachedStatusData.activity.find((event) => event.taskName === "smoke inspect schedules").requestBytes, 900);
  assert.equal(cachedStatusData.activity.find((event) => event.taskName === "smoke inspect schedules").responseBytes, 1800);

  writeJson(path.join(reportsRoot, "live", "machines", "TESTPC", "status.json"), {
    schemaVersion: "revagent.live.status.v1",
    machineName: "TESTPC",
    userName: "BT",
    lastHeartbeatUtc: new Date(now.getTime() + 11 * 60 * 1000).toISOString(),
    runtime: {
      version,
    },
    activeTask: null,
    activeTasks: [],
    recentActivity: [],
    revitStatus: {
      activeTask: null,
      recentTasks: [
        {
          id: "status-fresh-after-cache-expiry",
          method: "send_code_to_revit",
          taskName: "smoke fresh after cache expiry",
          state: "completed",
          startedAtUtc: new Date(now.getTime() + 11 * 60 * 1000).toISOString(),
          finishedAtUtc: new Date(now.getTime() + 11 * 60 * 1000 + 100).toISOString(),
          elapsedMs: 100,
          requestBytes: 777,
          responseBytes: 888,
          error: null,
        },
      ],
      recentHistoryCount: 1,
      recentHistoryCapacity: 100,
    },
    writeHealth: {
      droppedCount: 0,
    },
  });
  const realDateNow = Date.now;
  Date.now = () => now.getTime() + 11 * 60 * 1000;
  try {
    const expiredCacheData = loadDashboardData({
      reportsRoot,
      releaseRoot,
      staleSeconds: 60,
      offlineSeconds: 300,
      activityLimit: 20,
    });
    assert.equal(expiredCacheData.activity.some((event) => event.taskName === "smoke fresh after cache expiry"), true);
    assert.equal(expiredCacheData.activity.some((event) => event.taskName === "smoke status cleanup"), false);
  } finally {
    Date.now = realDateNow;
  }

  assert.equal("params" in data.activity[0], false);
  assert.equal(JSON.stringify(data).includes("\"preview\""), false);
  assert.equal(JSON.stringify(data).includes("yyyyyyyy"), false);
  assert.ok(JSON.stringify(data).length < 20000);
  assert.equal(data.summary.toolUsage[0].name, "inspect_elements");
  const brief = buildDashboardBrief(data);
  assert.equal(brief.schemaVersion, "revagent.dashboard.brief.v1");
  assert.equal(brief.machines.find((machine) => machine.machine === "TESTPC").latestActivity.taskName, "smoke status cleanup");

  console.log("Dashboard smoke test passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
