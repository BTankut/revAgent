import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REPORTS_ROOT = "\\\\DPE-NAS\\Dpe-Ortak\\Baris Tankut\\revit-mcp-deploy\\reports";
const DEFAULT_PORT = 8765;
const DEFAULT_ACTIVITY_READ_BYTES = 4 * 1024 * 1024;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index++;
    }
  }
  return args;
}

function resolveConfig(argv) {
  const args = parseArgs(argv);
  const reportsRoot = path.resolve(args.reportsRoot || process.env.REVAGENT_DASHBOARD_REPORTS_ROOT || DEFAULT_REPORTS_ROOT);
  const releaseRoot = path.resolve(
    args.releaseRoot ||
    process.env.REVAGENT_DASHBOARD_RELEASE_ROOT ||
    path.dirname(reportsRoot),
  );
  const port = Number.parseInt(String(args.port || process.env.REVAGENT_DASHBOARD_PORT || DEFAULT_PORT), 10);
  return {
    host: args.host || process.env.REVAGENT_DASHBOARD_HOST || "127.0.0.1",
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    reportsRoot,
    releaseRoot,
    staleSeconds: clampInt(args.staleSeconds || process.env.REVAGENT_DASHBOARD_STALE_SECONDS, 60, 10, 3600),
    activityLimit: clampInt(args.activityLimit || process.env.REVAGENT_DASHBOARD_ACTIVITY_LIMIT, 200, 20, 1000),
    activityReadBytes: clampInt(args.activityReadBytes || process.env.REVAGENT_DASHBOARD_ACTIVITY_READ_BYTES, DEFAULT_ACTIVITY_READ_BYTES, 256 * 1024, 32 * 1024 * 1024),
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      readError: error instanceof Error ? error.message : String(error),
      path: filePath,
    };
  }
}

function listDirectories(root) {
  try {
    if (!fs.existsSync(root)) {
      return [];
    }
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function readNdjsonTail(filePath, limit, maxBytes = DEFAULT_ACTIVITY_READ_BYTES) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, Math.max(1024, maxBytes));
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(readSize < stat.size ? 1 : 0)
      .slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function toUtcMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function secondsSince(value, now = Date.now()) {
  const ms = toUtcMs(value);
  return ms === null ? null : Math.max(0, Math.round((now - ms) / 1000));
}

function normalizeMachineName(value) {
  return String(value || "").trim().toUpperCase();
}

function chooseState(machine, live, stableVersion, now, staleSeconds) {
  const installed = machine?.installedVersion || machine?.localInstall?.version || "";
  const target = stableVersion || machine?.targetVersion || "";
  const reportStatus = String(machine?.status || "").toLowerCase();
  const liveAgeSeconds = secondsSince(live?.lastHeartbeatUtc, now);
  const liveState = !live
    ? "offline"
    : liveAgeSeconds !== null && liveAgeSeconds <= staleSeconds
      ? "online"
      : "stale";

  if (reportStatus === "failed") {
    return "failed";
  }
  if (machine?.diagnostics?.deferredForRevitClose === true) {
    return "deferred";
  }
  if (target && installed && installed !== target) {
    return "outdated";
  }
  if (liveState === "online" && live?.activeTask) {
    return "active";
  }
  return liveState === "online" ? "online" : "current";
}

function summarizeMachine(machineName, machineReport, liveStatus, stableVersion, now, staleSeconds) {
  const installedVersion = machineReport?.installedVersion || machineReport?.localInstall?.version || "";
  const reportedTargetVersion = machineReport?.targetVersion || "";
  const targetVersion = stableVersion || reportedTargetVersion || "";
  const liveAgeSeconds = secondsSince(liveStatus?.lastHeartbeatUtc, now);
  return {
    machine: machineName,
    computerName: machineReport?.computerName || liveStatus?.machineName || machineName,
    userName: machineReport?.userName || liveStatus?.userName || "",
    state: chooseState(machineReport, liveStatus, stableVersion, now, staleSeconds),
    updateStatus: machineReport?.status || "",
    operation: machineReport?.operation || "",
    operationMethod: machineReport?.operationMethod || "",
    installedVersion,
    targetVersion,
    reportedTargetVersion,
    stableVersion: stableVersion || "",
    versionCurrent: Boolean(installedVersion && targetVersion && installedVersion === targetVersion),
    atUtc: machineReport?.atUtc || "",
    deferredForRevitClose: machineReport?.diagnostics?.deferredForRevitClose === true,
    revitPayloadChanged: machineReport?.diagnostics?.revitPayloadChanged === true,
    fastPackageOnlyUpdate: machineReport?.diagnostics?.fastPackageOnlyUpdate === true,
    logPath: machineReport?.machineReport?.logPath || machineReport?.logPath || "",
    live: liveStatus ? {
      schemaVersion: liveStatus.schemaVersion,
      runtimeVersion: liveStatus.runtime?.version || "",
      lastHeartbeatUtc: liveStatus.lastHeartbeatUtc || "",
      heartbeatAgeSeconds: liveAgeSeconds,
      activeTask: compactActivity(liveStatus.activeTask),
      activeTasks: compactActivityList(liveStatus.activeTasks, 10),
      recentActivity: compactActivityList(liveStatus.recentActivity, 20),
      writeHealth: liveStatus.writeHealth || {},
    } : null,
  };
}

function withActivityFallback(machine, machineActivity) {
  if (!machine.live || machine.live.recentActivity.length > 0 || !Array.isArray(machineActivity) || machineActivity.length === 0) {
    return machine;
  }

  return {
    ...machine,
    live: {
      ...machine.live,
      recentActivity: sortActivities(machineActivity).slice(0, 20),
    },
  };
}

function summarizeLiveOperations(events) {
  const terminalToolEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.scope === "mcp.tool")
    .filter((event) => ["completed", "guarded", "failed"].includes(event.phase || event.state || ""));
  return {
    operationCount: terminalToolEvents.length,
    completedCount: terminalToolEvents.filter((event) => (event.phase || event.state) === "completed").length,
    guardedCount: terminalToolEvents.filter((event) => (event.phase || event.state) === "guarded").length,
    failedCount: terminalToolEvents.filter((event) => (event.phase || event.state) === "failed").length,
  };
}

function summarizeOverview(data) {
  const machines = data.machines || [];
  const liveMachines = machines.filter((machine) => machine.live && machine.live.heartbeatAgeSeconds !== null && machine.live.heartbeatAgeSeconds <= data.staleSeconds);
  const liveOperations = summarizeLiveOperations(data.activity);
  const summaryGuardedCount = Array.isArray(data.summary?.friction?.guarded) ? data.summary.friction.guarded.length : 0;
  const summaryFailedCount = Array.isArray(data.summary?.friction?.failed) ? data.summary.friction.failed.length : 0;
  return {
    machineCount: machines.length,
    currentVersionCount: machines.filter((machine) => machine.versionCurrent).length,
    liveMachineCount: liveMachines.length,
    activeMachineCount: liveMachines.filter((machine) => machine.live?.activeTask).length,
    failedMachineCount: machines.filter((machine) => machine.state === "failed").length,
    staleMachineCount: machines.filter((machine) => machine.live && machine.live.heartbeatAgeSeconds !== null && machine.live.heartbeatAgeSeconds > data.staleSeconds).length,
    summaryDateUtc: data.summary?.dateUtc || "",
    eventCount: data.summary?.source?.eventCount || 0,
    sessionCount: data.summary?.totals?.sessionCount || 0,
    productionOperationCount: liveOperations.operationCount,
    guardedCount: liveOperations.guardedCount,
    failedCount: liveOperations.failedCount,
    liveOperationCount: liveOperations.operationCount,
    liveCompletedCount: liveOperations.completedCount,
    liveGuardedCount: liveOperations.guardedCount,
    liveFailedCount: liveOperations.failedCount,
    summaryProductionOperationCount: data.summary?.production?.operationCount || 0,
    summaryGuardedCount,
    summaryFailedCount,
    sendCodeCount: data.summary?.sendCode?.count || 0,
    metricSource: "liveActivity",
  };
}

function sortActivities(events) {
  return events
    .filter(Boolean)
    .sort((a, b) => String(b.timestampUtc || b.finishedAtUtc || b.startedAtUtc || "").localeCompare(String(a.timestampUtc || a.finishedAtUtc || a.startedAtUtc || "")));
}

function compactActivity(event) {
  if (!event) {
    return null;
  }
  const result = event.result && typeof event.result === "object"
    ? {
        success: event.result.success ?? null,
        guarded: event.result.guarded === true,
        state: event.result.state || null,
        action: event.result.action || null,
        errorMessage: event.result.errorMessage || null,
      }
    : null;
  return {
    schemaVersion: event.schemaVersion || "",
    eventType: event.eventType || "",
    eventId: event.eventId || "",
    timestampUtc: event.timestampUtc || event.finishedAtUtc || event.startedAtUtc || "",
    machineName: event.machineName || "",
    userName: event.userName || "",
    phase: event.phase || event.state || "",
    state: event.state || event.phase || "",
    scope: event.scope || "",
    toolName: event.toolName || "",
    commandName: event.commandName || "",
    logicalToolName: event.logicalToolName || "",
    executionKind: event.executionKind || "",
    taskName: event.taskName || "",
    taskIdPresent: event.taskIdPresent === true,
    startedAtUtc: event.startedAtUtc || "",
    finishedAtUtc: event.finishedAtUtc || "",
    durationMs: event.durationMs ?? null,
    result,
  };
}

function compactActivityList(events, limit) {
  return (Array.isArray(events) ? events : [])
    .slice(0, limit)
    .map(compactActivity)
    .filter(Boolean);
}

function compactFrictionList(items, phase, limit = 50) {
  return (Array.isArray(items) ? items : [])
    .slice(0, limit)
    .map((item) => compactActivity({ ...item, phase: item.phase || phase, state: item.state || phase }))
    .filter(Boolean);
}

function compactSendCode(sendCode) {
  if (!sendCode || typeof sendCode !== "object") {
    return {};
  }
  return {
    count: sendCode.count || 0,
    rawCount: sendCode.rawCount || 0,
    safeCount: sendCode.safeCount || 0,
    guardedCount: sendCode.guardedCount || 0,
    failedCount: sendCode.failedCount || 0,
    manualTransactionCount: sendCode.manualTransactionCount || 0,
    writePatternCount: sendCode.writePatternCount || 0,
  };
}

function compactSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return summary || null;
  }
  if (summary.readError) {
    return summary;
  }
  const friction = summary.friction || {};
  return {
    schemaVersion: summary.schemaVersion || "",
    dateUtc: summary.dateUtc || "",
    generatedAtUtc: summary.generatedAtUtc || "",
    source: summary.source || {},
    totals: summary.totals || {},
    production: summary.production || {},
    sendCode: compactSendCode(summary.sendCode),
    toolUsage: Array.isArray(summary.toolUsage) ? summary.toolUsage.slice(0, 50) : [],
    commandUsage: Array.isArray(summary.commandUsage) ? summary.commandUsage.slice(0, 50) : [],
    friction: {
      failed: compactFrictionList(friction.failed, "failed"),
      guarded: compactFrictionList(friction.guarded, "guarded"),
      slow: compactFrictionList(friction.slow, "started"),
    },
  };
}

export function loadDashboardData(config = {}) {
  const now = Date.now();
  const reportsRoot = config.reportsRoot || DEFAULT_REPORTS_ROOT;
  const releaseRoot = config.releaseRoot || path.dirname(reportsRoot);
  const staleSeconds = clampInt(config.staleSeconds, 60, 10, 3600);
  const activityLimit = clampInt(config.activityLimit, 200, 20, 1000);
  const activityReadBytes = clampInt(config.activityReadBytes, DEFAULT_ACTIVITY_READ_BYTES, 256 * 1024, 32 * 1024 * 1024);
  const summariesRoot = path.join(reportsRoot, "summaries");
  const machinesRoot = path.join(reportsRoot, "machines");
  const liveRoot = path.join(reportsRoot, "live", "machines");
  const stable = readJsonFile(path.join(releaseRoot, "channels", "stable.json"));
  const summary = compactSummary(readJsonFile(path.join(summariesRoot, "latest.json")));
  const publish = readJsonFile(path.join(summariesRoot, "publish-latest.json"));
  const todayUtc = new Date(now).toISOString().slice(0, 10);

  const machineNames = [...new Set([
    ...listDirectories(machinesRoot),
    ...listDirectories(liveRoot),
  ].map(normalizeMachineName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const activityByMachine = new Map(machineNames.map((machineName) => {
    const activityPath = path.join(liveRoot, machineName, "activity", `${todayUtc}.ndjson`);
    return [machineName, readNdjsonTail(activityPath, activityLimit, activityReadBytes).map(compactActivity).filter(Boolean)];
  }));

  const machines = machineNames.map((machineName) => {
    const machineReport = readJsonFile(path.join(machinesRoot, machineName, "latest.json"));
    const liveStatus = readJsonFile(path.join(liveRoot, machineName, "status.json"));
    const machine = summarizeMachine(machineName, machineReport, liveStatus, stable?.version || "", now, staleSeconds);
    return withActivityFallback(machine, activityByMachine.get(machineName));
  });

  const activity = sortActivities(machines.flatMap((machine) => {
    return (activityByMachine.get(machine.machine) || []).map((event) => ({
      ...event,
      machineName: event.machineName || machine.machine,
    }));
  })).slice(0, activityLimit);

  const data = {
    schemaVersion: "revagent.dashboard.snapshot.v1",
    generatedAtUtc: new Date(now).toISOString(),
    reportsRoot,
    releaseRoot,
    staleSeconds,
    stable,
    summary,
    publish,
    machines,
    activity,
  };
  return {
    ...data,
    overview: summarizeOverview(data),
  };
}

function compactTask(task) {
  if (!task) {
    return null;
  }
  return {
    taskName: task.taskName || task.toolName || task.commandName || task.logicalToolName || "",
    toolName: task.toolName || "",
    commandName: task.commandName || "",
    scope: task.scope || "",
    state: task.state || task.phase || "",
    timestampUtc: task.timestampUtc || task.finishedAtUtc || task.startedAtUtc || "",
    durationMs: task.durationMs ?? null,
    guarded: task.result?.guarded === true,
    success: task.result?.success ?? null,
  };
}

function latestMachineActivity(machine) {
  const recent = Array.isArray(machine.live?.recentActivity) ? machine.live.recentActivity : [];
  return sortActivities(recent)[0] || null;
}

export function buildDashboardBrief(data) {
  const snapshot = data || loadDashboardData();
  const friction = snapshot.summary?.friction || {};
  return {
    schemaVersion: "revagent.dashboard.brief.v1",
    generatedAtUtc: snapshot.generatedAtUtc,
    stableVersion: snapshot.stable?.version || "",
    summaryDateUtc: snapshot.summary?.dateUtc || "",
    overview: snapshot.overview,
    machines: (snapshot.machines || []).map((machine) => ({
      machine: machine.machine,
      userName: machine.userName,
      state: machine.state,
      installedVersion: machine.installedVersion,
      targetVersion: machine.targetVersion,
      versionCurrent: machine.versionCurrent,
      heartbeatAgeSeconds: machine.live?.heartbeatAgeSeconds ?? null,
      activeTask: compactTask(machine.live?.activeTask),
      latestActivity: compactTask(latestMachineActivity(machine)),
      updateStatus: machine.updateStatus,
      deferredForRevitClose: machine.deferredForRevitClose,
    })),
    recentActivity: (snapshot.activity || []).slice(0, 80).map(compactTask),
    toolUsage: Array.isArray(snapshot.summary?.toolUsage) ? snapshot.summary.toolUsage.slice(0, 20) : [],
    friction: {
      failed: Array.isArray(friction.failed) ? friction.failed.slice(0, 20) : [],
      guarded: Array.isArray(friction.guarded) ? friction.guarded.slice(0, 20) : [],
      slow: Array.isArray(friction.slow) ? friction.slow.slice(0, 20) : [],
    },
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(response, requestPath) {
  const publicRoot = path.join(__dirname, "public");
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const decoded = decodeURIComponent(cleanPath);
  const filePath = path.resolve(publicRoot, `.${decoded}`);
  const relative = path.relative(publicRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, "Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=60",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
}

export function createDashboardServer(config) {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/overview") {
      sendJson(response, 200, loadDashboardData(config));
      return;
    }
    if (url.pathname === "/api/brief") {
      sendJson(response, 200, buildDashboardBrief(loadDashboardData(config)));
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        generatedAtUtc: new Date().toISOString(),
        reportsRoot: config.reportsRoot,
      });
      return;
    }
    serveStatic(response, url.pathname);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = resolveConfig();
  const server = createDashboardServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`revAgent dashboard: http://${config.host}:${config.port}`);
    console.log(`Reports root: ${config.reportsRoot}`);
  });
}
