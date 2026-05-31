import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REPORTS_ROOT = "\\\\DPE-NAS\\Dpe-Ortak\\Baris Tankut\\revit-mcp-deploy\\reports";
const DEFAULT_PORT = 8765;

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

function readNdjsonTail(filePath, limit) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const lines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
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
  const target = machine?.targetVersion || stableVersion || "";
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
  const targetVersion = machineReport?.targetVersion || stableVersion || "";
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
      activeTask: liveStatus.activeTask || null,
      activeTasks: Array.isArray(liveStatus.activeTasks) ? liveStatus.activeTasks : [],
      recentActivity: Array.isArray(liveStatus.recentActivity) ? liveStatus.recentActivity.slice(0, 20) : [],
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

function summarizeOverview(data) {
  const machines = data.machines || [];
  const liveMachines = machines.filter((machine) => machine.live && machine.live.heartbeatAgeSeconds !== null && machine.live.heartbeatAgeSeconds <= data.staleSeconds);
  return {
    machineCount: machines.length,
    currentVersionCount: machines.filter((machine) => machine.versionCurrent).length,
    liveMachineCount: liveMachines.length,
    activeMachineCount: machines.filter((machine) => machine.state === "active").length,
    failedMachineCount: machines.filter((machine) => machine.state === "failed").length,
    staleMachineCount: machines.filter((machine) => machine.live && machine.live.heartbeatAgeSeconds !== null && machine.live.heartbeatAgeSeconds > data.staleSeconds).length,
    summaryDateUtc: data.summary?.dateUtc || "",
    eventCount: data.summary?.source?.eventCount || 0,
    sessionCount: data.summary?.totals?.sessionCount || 0,
    productionOperationCount: data.summary?.production?.operationCount || 0,
    guardedCount: Array.isArray(data.summary?.friction?.guarded) ? data.summary.friction.guarded.length : 0,
    failedCount: Array.isArray(data.summary?.friction?.failed) ? data.summary.friction.failed.length : 0,
    sendCodeCount: data.summary?.sendCode?.count || 0,
  };
}

function sortActivities(events) {
  return events
    .filter(Boolean)
    .sort((a, b) => String(b.timestampUtc || b.finishedAtUtc || b.startedAtUtc || "").localeCompare(String(a.timestampUtc || a.finishedAtUtc || a.startedAtUtc || "")));
}

export function loadDashboardData(config = {}) {
  const now = Date.now();
  const reportsRoot = config.reportsRoot || DEFAULT_REPORTS_ROOT;
  const releaseRoot = config.releaseRoot || path.dirname(reportsRoot);
  const staleSeconds = clampInt(config.staleSeconds, 60, 10, 3600);
  const activityLimit = clampInt(config.activityLimit, 200, 20, 1000);
  const summariesRoot = path.join(reportsRoot, "summaries");
  const machinesRoot = path.join(reportsRoot, "machines");
  const liveRoot = path.join(reportsRoot, "live", "machines");
  const stable = readJsonFile(path.join(releaseRoot, "channels", "stable.json"));
  const summary = readJsonFile(path.join(summariesRoot, "latest.json"));
  const publish = readJsonFile(path.join(summariesRoot, "publish-latest.json"));
  const todayUtc = new Date(now).toISOString().slice(0, 10);

  const machineNames = [...new Set([
    ...listDirectories(machinesRoot),
    ...listDirectories(liveRoot),
  ].map(normalizeMachineName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const activityByMachine = new Map(machineNames.map((machineName) => {
    const activityPath = path.join(liveRoot, machineName, "activity", `${todayUtc}.ndjson`);
    return [machineName, readNdjsonTail(activityPath, activityLimit)];
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
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
