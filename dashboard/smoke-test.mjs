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
    writeHealth: {
      droppedCount: 0,
    },
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    phase: "started",
    machineName: "TESTPC",
    toolName: "inspect_elements",
    taskName: "smoke inspect",
    timestampUtc: now.toISOString(),
  });

  appendNdjson(path.join(reportsRoot, "live", "machines", "TESTPC", "activity", `${todayUtc}.ndjson`), {
    schemaVersion: "revagent.live.activity.v1",
    phase: "completed",
    machineName: "TESTPC",
    toolName: "inspect_elements",
    taskName: "smoke inspect",
    timestampUtc: new Date(now.getTime() + 1000).toISOString(),
    durationMs: 1000,
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
    activityLimit: 20,
  });

  assert.equal(data.schemaVersion, "revagent.dashboard.snapshot.v1");
  assert.equal(data.stable.version, version);
  assert.equal(data.overview.machineCount, 1);
  assert.equal(data.overview.liveMachineCount, 1);
  assert.equal(data.overview.activeMachineCount, 1);
  assert.equal(data.overview.productionOperationCount, 2);
  assert.equal(data.machines[0].machine, "TESTPC");
  assert.equal(data.machines[0].state, "active");
  assert.equal(data.machines[0].versionCurrent, true);
  assert.equal(data.machines[0].live.activeTask.taskName, "smoke inspect");
  assert.equal(data.machines[0].live.recentActivity[0].taskName, "smoke inspect");
  assert.equal(data.activity.length, 2);
  assert.equal(data.activity[0].phase, "completed");
  assert.equal(data.summary.toolUsage[0].name, "inspect_elements");
  const brief = buildDashboardBrief(data);
  assert.equal(brief.schemaVersion, "revagent.dashboard.brief.v1");
  assert.equal(brief.machines[0].machine, "TESTPC");
  assert.equal(brief.machines[0].latestActivity.taskName, "smoke inspect");

  console.log("Dashboard smoke test passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
