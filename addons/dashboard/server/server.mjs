import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeRevitStatusSnapshots, unexpiredCachedRevitStatus } from "../../../installer/runtime-mcp-server/build/utils/revitTaskMerge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REPORTS_ROOT = "\\\\DPE-NAS\\Dpe-Ortak\\Baris Tankut\\revit-mcp-deploy\\reports";
const DEFAULT_PORT = 8765;
const DEFAULT_ACTIVITY_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_STALE_SECONDS = 60;
const DEFAULT_OFFLINE_SECONDS = 300;
const LIVE_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;
const liveStatusCache = new Map();

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
  const staleSeconds = clampInt(args.staleSeconds || process.env.REVAGENT_DASHBOARD_STALE_SECONDS, DEFAULT_STALE_SECONDS, 10, 3600);
  const offlineSeconds = clampInt(args.offlineSeconds || process.env.REVAGENT_DASHBOARD_OFFLINE_SECONDS, DEFAULT_OFFLINE_SECONDS, staleSeconds + 10, 86400);
  return {
    host: args.host || process.env.REVAGENT_DASHBOARD_HOST || "127.0.0.1",
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    reportsRoot,
    releaseRoot,
    staleSeconds,
    offlineSeconds,
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

function hasUsefulRevitStatus(status) {
  const revitStatus = status?.revitStatus;
  const recentTasks = Array.isArray(revitStatus?.recentTasks) ? revitStatus.recentTasks : [];
  return Boolean(revitStatus?.activeTask || recentTasks.length > 0);
}

function mergeLiveStatusCache(machineName, liveStatus, now, offlineSeconds) {
  if (!liveStatus) {
    return liveStatus;
  }

  const key = normalizeMachineName(machineName || liveStatus.machineName || "");
  const currentRevitStatus = liveStatus.revitStatus || null;
  const cached = liveStatusCache.get(key);
  const cacheTtlMs = Math.max(LIVE_STATUS_CACHE_TTL_MS, Number(offlineSeconds || DEFAULT_OFFLINE_SECONDS) * 1000);
  const cachedRevitStatus = unexpiredCachedRevitStatus(cached, now, cacheTtlMs);

  if (hasUsefulRevitStatus(liveStatus)) {
    const mergedRevitStatus = mergeRevitStatusSnapshots(currentRevitStatus, cachedRevitStatus);
    const mergedLiveStatus = {
      ...liveStatus,
      revitStatus: mergedRevitStatus,
    };
    liveStatusCache.set(key, {
      cachedAtMs: now,
      revitStatus: mergedRevitStatus,
    });
    return mergedLiveStatus;
  }

  if (!cachedRevitStatus || !hasUsefulRevitStatus({ revitStatus: cachedRevitStatus })) {
    return liveStatus;
  }

  return {
    ...liveStatus,
    revitStatus: mergeRevitStatusSnapshots(currentRevitStatus, cachedRevitStatus),
  };
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

const VERSION_SUCCESS_STATUSES = new Set([
  "completed",
  "current",
  "installed",
  "reinstalled",
  "repaired",
  "success",
  "succeeded",
  "updated",
]);

function installedVersionFor(report) {
  return report?.installedVersion || report?.localInstall?.version || "";
}

function targetVersionFor(report) {
  return report?.targetVersion || report?.release?.version || "";
}

function reportTimestampMs(report) {
  const candidates = [
    report?.atUtc,
    report?.reportedAtUtc,
    report?.publishedAtUtc,
    report?.machineReport?.publishedAtUtc,
  ];
  for (const candidate of candidates) {
    const ms = toUtcMs(candidate);
    if (ms !== null) {
      return ms;
    }
  }
  return 0;
}

function isSuccessfulVersionReport(report) {
  const status = String(report?.status || "").toLowerCase();
  return Boolean(installedVersionFor(report) && VERSION_SUCCESS_STATUSES.has(status));
}

function chooseVersionReport(primaryReport, candidateReports) {
  if (installedVersionFor(primaryReport)) {
    return primaryReport;
  }
  return [...(candidateReports || [])]
    .filter(isSuccessfulVersionReport)
    .sort((a, b) => reportTimestampMs(b) - reportTimestampMs(a))[0] || primaryReport;
}

function withVersionFallback(primaryReport, versionReport) {
  if (!primaryReport || !versionReport || primaryReport === versionReport || installedVersionFor(primaryReport)) {
    return primaryReport;
  }
  const fallbackInstalledVersion = installedVersionFor(versionReport);
  if (!fallbackInstalledVersion) {
    return primaryReport;
  }
  return {
    ...primaryReport,
    installedVersion: fallbackInstalledVersion,
    targetVersion: targetVersionFor(primaryReport) || targetVersionFor(versionReport),
    localInstall: primaryReport.localInstall || versionReport.localInstall || null,
    versionFallback: {
      status: versionReport.status || "",
      operation: versionReport.operation || "",
      operationMethod: versionReport.operationMethod || "",
      atUtc: versionReport.atUtc || "",
      logPath: versionReport.machineReport?.logPath || versionReport.logPath || "",
    },
  };
}

function chooseState(machine, live, stableVersion, now, staleSeconds, offlineSeconds) {
  const installed = installedVersionFor(machine);
  const target = stableVersion || targetVersionFor(machine);
  const reportStatus = String(machine?.status || "").toLowerCase();
  const liveState = connectionStateFor(live, now, staleSeconds, offlineSeconds);

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

function connectionStateFor(live, now, staleSeconds, offlineSeconds) {
  const liveAgeSeconds = secondsSince(live?.lastHeartbeatUtc, now);
  if (!live || liveAgeSeconds === null) {
    return "offline";
  }
  if (liveAgeSeconds <= staleSeconds) {
    return "online";
  }
  return liveAgeSeconds <= offlineSeconds ? "stale" : "offline";
}

function versionStateFor(machine, stableVersion) {
  const installed = installedVersionFor(machine);
  const target = stableVersion || targetVersionFor(machine);
  if (!installed || !target) {
    return "unknown";
  }
  return installed === target ? "upToDate" : "outdated";
}

function taskStateFor(live, now, staleSeconds, offlineSeconds) {
  return connectionStateFor(live, now, staleSeconds, offlineSeconds) === "online" && live?.activeTask ? "running" : "idle";
}

function updateStateFor(machine) {
  const reportStatus = String(machine?.status || "").toLowerCase();
  if (reportStatus === "failed") {
    return "failed";
  }
  if (machine?.diagnostics?.deferredForRevitClose === true) {
    return "deferred";
  }
  return "ok";
}

function summarizeMachine(machineName, machineReport, liveStatus, stableVersion, now, staleSeconds, offlineSeconds) {
  const installedVersion = installedVersionFor(machineReport);
  const reportedTargetVersion = targetVersionFor(machineReport);
  const targetVersion = stableVersion || reportedTargetVersion || "";
  const liveAgeSeconds = secondsSince(liveStatus?.lastHeartbeatUtc, now);
  return {
    machine: machineName,
    computerName: machineReport?.computerName || liveStatus?.machineName || machineName,
    userName: machineReport?.userName || liveStatus?.userName || "",
    state: chooseState(machineReport, liveStatus, stableVersion, now, staleSeconds, offlineSeconds),
    connectionState: connectionStateFor(liveStatus, now, staleSeconds, offlineSeconds),
    versionState: versionStateFor(machineReport, stableVersion),
    taskState: taskStateFor(liveStatus, now, staleSeconds, offlineSeconds),
    updateState: updateStateFor(machineReport),
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
    versionFallback: machineReport?.versionFallback || null,
    live: liveStatus ? {
      schemaVersion: liveStatus.schemaVersion,
      runtimeVersion: liveStatus.runtime?.version || "",
      lastHeartbeatUtc: liveStatus.lastHeartbeatUtc || "",
      heartbeatAgeSeconds: liveAgeSeconds,
      activeTask: compactActivity(liveStatus.activeTask),
      activeTasks: compactActivityList(liveStatus.activeTasks, 10),
      recentActivity: compactActivityList(liveStatus.recentActivity, 20),
      revitStatus: liveStatus.revitStatus || null,
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

function activityTimestamp(event) {
  return event?.timestampUtc || event?.finishedAtUtc || event?.startedAtUtc || "";
}

function activityTimeMs(event) {
  const ms = Date.parse(String(activityTimestamp(event) || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function activityStartMs(event) {
  const ms = Date.parse(String(event?.startedAtUtc || event?.timestampUtc || event?.finishedAtUtc || ""));
  return Number.isFinite(ms) ? ms : activityTimeMs(event);
}

function isTerminalPhase(phase) {
  return ["completed", "guarded", "failed"].includes(phase);
}

function displayPhaseForEvent(event) {
  const phase = event?.phase || event?.state || "completed";
  const normalizedPhase = phase === "running" ? "started" : phase === "blocked" ? "guarded" : phase;
  const errorMessage = String(event?.result?.errorMessage || "").toLowerCase();
  const action = String(event?.result?.action || "").toLowerCase();
  const guidedUnsupportedResult =
    errorMessage.includes("unsupported_view_type_for_image_export") ||
    errorMessage.includes("schedule_views_cannot_be_exported_directly") ||
    action.includes("unsupported_view_type_for_image_export");

  // A controlled "unsupported, here is the sheet to use" response is not an
  // operational failure in the live status board. Keep raw telemetry as-is;
  // only normalize the dashboard presentation to match the Revit status window.
  if (normalizedPhase === "failed" && guidedUnsupportedResult) {
    return "completed";
  }

  return normalizedPhase;
}

function phasePriority(phase) {
  if (phase === "failed") return 4;
  if (phase === "guarded") return 3;
  if (phase === "completed") return 2;
  if (phase === "started") return 1;
  return 0;
}

function normalizeDisplayPhase(event) {
  if (!event) {
    return null;
  }
  const phase = displayPhaseForEvent(event);
  return {
    ...event,
    rawPhase: event.phase || "",
    rawState: event.state || "",
    phase,
    state: phase,
  };
}

function collapseLifecycleEvents(events) {
  const keyed = new Map();
  const unkeyed = [];

  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    const key = event.liveTaskId || "";
    const normalized = normalizeDisplayPhase(event);
    if (!key) {
      unkeyed.push(normalized);
      continue;
    }

    const existing = keyed.get(key);
    if (!existing) {
      keyed.set(key, normalized);
      continue;
    }

    const existingTerminal = isTerminalPhase(existing.phase);
    const candidateTerminal = isTerminalPhase(normalized.phase);
    if ((candidateTerminal && !existingTerminal) ||
      (candidateTerminal === existingTerminal && activityTimeMs(normalized) >= activityTimeMs(existing))) {
      keyed.set(key, normalized);
    }
  }

  return [...keyed.values(), ...unkeyed];
}

function taskGroupingName(event) {
  return String(event?.taskName || event?.toolName || event?.commandName || event?.logicalToolName || "").trim().toLowerCase();
}

function canGroupNestedEvent(group, event) {
  const hasSameScope = group.events.some((item) => item.scope === event.scope);
  if (hasSameScope) {
    return false;
  }
  const scopes = new Set([...group.events.map((item) => item.scope), event.scope]);
  return scopes.has("mcp.tool") && scopes.has("revit.command");
}

function chooseNestedGroup(groups, event) {
  const machine = normalizeMachineName(event.machineName || "");
  const name = taskGroupingName(event);
  if (!name) {
    return null;
  }
  const startMs = activityStartMs(event);
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const group of groups) {
    if (group.machine !== machine || group.name !== name || !canGroupNestedEvent(group, event)) {
      continue;
    }
    const delta = Math.abs(group.startMs - startMs);
    if (delta <= 2000 && delta < bestDelta) {
      best = group;
      bestDelta = delta;
    }
  }

  return best;
}

function mergeNestedActivityGroup(group) {
  const events = group.events;
  const displayBase =
    events.find((event) => event.scope === "mcp.tool") ||
    events.find((event) => event.scope === "revit.command") ||
    events[0];
  const terminalEvents = events.filter((event) => isTerminalPhase(event.phase));
  const stateBase = terminalEvents
    .slice()
    .sort((a, b) => {
      const priorityDelta = phasePriority(b.phase) - phasePriority(a.phase);
      if (priorityDelta !== 0) return priorityDelta;
      if (a.scope === "mcp.tool" && b.scope !== "mcp.tool") return -1;
      if (b.scope === "mcp.tool" && a.scope !== "mcp.tool") return 1;
      return activityTimeMs(b) - activityTimeMs(a);
    })[0] || displayBase;
  const phase = stateBase.phase || displayBase.phase || "completed";

  return {
    ...displayBase,
    timestampUtc: activityTimestamp(stateBase) || activityTimestamp(displayBase),
    phase,
    state: phase,
    startedAtUtc: stateBase.startedAtUtc || displayBase.startedAtUtc || "",
    finishedAtUtc: stateBase.finishedAtUtc || displayBase.finishedAtUtc || "",
    durationMs: stateBase.durationMs ?? displayBase.durationMs ?? null,
    requestBytes: stateBase.requestBytes ?? displayBase.requestBytes ?? null,
    responseBytes: stateBase.responseBytes ?? displayBase.responseBytes ?? null,
    result: stateBase.result || displayBase.result || null,
    groupedEventCount: events.length,
    groupedScopes: [...new Set(events.map((event) => event.scope).filter(Boolean))],
  };
}

function collapseNestedActivities(events) {
  const groups = [];
  const sorted = [...(Array.isArray(events) ? events : [])]
    .filter(Boolean)
    .sort((a, b) => activityStartMs(a) - activityStartMs(b));

  for (const event of sorted) {
    const group = chooseNestedGroup(groups, event);
    if (group) {
      group.events.push(event);
      group.startMs = Math.min(group.startMs, activityStartMs(event));
      continue;
    }

    groups.push({
      machine: normalizeMachineName(event.machineName || ""),
      name: taskGroupingName(event),
      startMs: activityStartMs(event),
      events: [event],
    });
  }

  return groups.map(mergeNestedActivityGroup);
}

function buildStatusActivities(events) {
  return sortActivities(collapseNestedActivities(collapseLifecycleEvents(events)));
}

function revitStatusPhase(task) {
  const state = String(task?.state || "").toLowerCase();
  if (state === "running") return "started";
  if (state === "blocked" || state === "guarded") return "guarded";
  if (state === "failed") return "failed";
  return "completed";
}

function revitStatusTaskToActivity(task, machineName) {
  if (!task) {
    return null;
  }
  const phase = revitStatusPhase(task);
  const wrapperAction = task.wrapperAction || task.logicalToolName || "";
  const displayToolName = wrapperAction || task.method || "";
  return {
    schemaVersion: "revagent.dashboard.revit-status-task.v1",
    eventType: "revit.status.task",
    eventId: task.id || task.requestId || "",
    liveTaskId: task.id || task.requestId || "",
    timestampUtc: task.finishedAtUtc || task.startedAtUtc || "",
    machineName,
    phase,
    state: phase,
    scope: "revit.status",
    toolName: displayToolName,
    commandName: task.method || "",
    logicalToolName: task.logicalToolName || displayToolName,
    taskName: task.taskName || task.method || "revAgent task",
    parentTaskName: task.parentTaskName || null,
    parentTaskIdPresent: Boolean(task.parentTaskIdPresent || task.parentTaskId),
    startedAtUtc: task.startedAtUtc || "",
    finishedAtUtc: task.finishedAtUtc || "",
    durationMs: task.elapsedMs ?? null,
    requestBytes: task.requestBytes ?? null,
    responseBytes: task.responseBytes ?? null,
    result: {
      success: phase !== "failed",
      guarded: phase === "guarded",
      action: wrapperAction || task.method || null,
      errorMessage: task.error || null,
    },
    source: "revit.status",
  };
}

function buildRevitStatusActivities(liveStatus, machineName) {
  const tasks = Array.isArray(liveStatus?.revitStatus?.recentTasks)
    ? liveStatus.revitStatus.recentTasks
    : [];
  return sortActivities(tasks.map((task) => revitStatusTaskToActivity(task, machineName)).filter(Boolean));
}

function sameTaskName(left, right) {
  return taskGroupingName(left) && taskGroupingName(left) === taskGroupingName(right);
}

function telemetryDisplayToolName(event) {
  if (!event) {
    return "";
  }
  const action = event.result && typeof event.result === "object" ? event.result.action || "" : "";
  if (event.scope === "mcp.tool" && event.toolName) {
    return event.toolName;
  }
  if (event.toolName && event.toolName !== "send_code_to_revit") {
    return event.toolName;
  }
  if (event.logicalToolName && event.logicalToolName !== "send_code_to_revit" && event.logicalToolName !== event.taskName) {
    return event.logicalToolName;
  }
  if (action && action !== "send_code_to_revit") {
    return action;
  }
  return event.toolName || event.commandName || event.logicalToolName || "";
}

function telemetryMatchScore(event) {
  if (!event) {
    return 0;
  }
  let score = 0;
  if (event.scope === "mcp.tool") score += 100;
  if (event.toolName && event.toolName !== "send_code_to_revit") score += 50;
  if (event.groupedEventCount) score += 10;
  if (telemetryDisplayToolName(event) && telemetryDisplayToolName(event) !== "send_code_to_revit") score += 10;
  return score;
}

function findMatchingTelemetryActivity(statusEvent, telemetryActivities) {
  if (!statusEvent || !Array.isArray(telemetryActivities) || !taskGroupingName(statusEvent)) {
    return null;
  }
  const statusMs = activityStartMs(statusEvent);
  return telemetryActivities
    .filter((event) => sameTaskName(event, statusEvent))
    .map((event) => ({
      event,
      delta: Math.abs(activityStartMs(event) - statusMs),
      score: telemetryMatchScore(event),
    }))
    .filter((candidate) => candidate.delta <= 5000)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.delta - b.delta;
    })[0]?.event || null;
}

function enrichRevitStatusActivity(statusEvent, telemetryActivities) {
  if (!statusEvent) {
    return statusEvent;
  }
  const telemetryEvent = findMatchingTelemetryActivity(statusEvent, telemetryActivities);
  if (!telemetryEvent) {
    return statusEvent;
  }
  const displayToolName = telemetryDisplayToolName(telemetryEvent);
  const groupedScopes = [
    ...new Set([
      ...(Array.isArray(telemetryEvent.groupedScopes) ? telemetryEvent.groupedScopes : []),
      telemetryEvent.scope,
      statusEvent.scope,
    ].filter(Boolean)),
  ];
  return {
    ...statusEvent,
    scope: telemetryEvent.scope === "mcp.tool" ? "mcp.tool" : statusEvent.scope,
    toolName: displayToolName || statusEvent.toolName,
    logicalToolName: telemetryEvent.logicalToolName || displayToolName || statusEvent.logicalToolName,
    result: {
      ...(statusEvent.result || {}),
      action: telemetryEvent.result?.action || statusEvent.result?.action || null,
    },
    source: displayToolName && displayToolName !== statusEvent.toolName ? "revit.status+telemetry" : statusEvent.source,
    groupedEventCount: Math.max(telemetryEvent.groupedEventCount || 0, 1) + 1,
    groupedScopes,
  };
}

function isCoveredByRevitStatus(event, revitStatusActivities) {
  if (!taskGroupingName(event)) {
    return false;
  }
  const eventMs = activityStartMs(event);
  return revitStatusActivities.some((statusEvent) => {
    if (!sameTaskName(event, statusEvent)) {
      return false;
    }
    const statusMs = activityStartMs(statusEvent);
    return Math.abs(statusMs - eventMs) <= 5000;
  });
}

function chooseRecentActivities(liveStatus, machineName, telemetryActivities) {
  const revitStatusActivities = buildRevitStatusActivities(liveStatus, machineName);
  const statusActivities = buildStatusActivities(telemetryActivities);
  if (revitStatusActivities.length > 0) {
    const enrichedRevitStatusActivities = revitStatusActivities.map((event) => enrichRevitStatusActivity(event, statusActivities));
    const telemetryOnly = statusActivities.filter((event) => !isCoveredByRevitStatus(event, revitStatusActivities));
    return sortActivities([...enrichedRevitStatusActivities, ...telemetryOnly]);
  }
  return statusActivities.length > 0
    ? statusActivities
    : buildStatusActivities(liveStatus?.recentActivity || []);
}

function summarizeLiveOperations(events) {
  const terminalToolEvents = (Array.isArray(events) ? events : [])
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
  const liveMachines = machines.filter((machine) => machine.connectionState === "online");
  const liveOperations = summarizeLiveOperations(data.activity);
  const summaryGuardedCount = Array.isArray(data.summary?.friction?.guarded) ? data.summary.friction.guarded.length : 0;
  const summaryFailedCount = Array.isArray(data.summary?.friction?.failed) ? data.summary.friction.failed.length : 0;
  return {
    machineCount: machines.length,
    currentVersionCount: machines.filter((machine) => machine.versionCurrent).length,
    liveMachineCount: liveMachines.length,
    activeMachineCount: machines.filter((machine) => machine.taskState === "running").length,
    failedMachineCount: machines.filter((machine) => machine.state === "failed").length,
    staleMachineCount: machines.filter((machine) => machine.connectionState === "stale").length,
    offlineMachineCount: machines.filter((machine) => machine.connectionState === "offline").length,
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
  const displayToolName = event.toolName || event.logicalToolName || event.commandName || "";
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
    liveTaskId: event.liveTaskId || "",
    timestampUtc: event.timestampUtc || event.finishedAtUtc || event.startedAtUtc || "",
    machineName: event.machineName || "",
    userName: event.userName || "",
    phase: event.phase || event.state || "",
    state: event.state || event.phase || "",
    scope: event.scope || "",
    toolName: displayToolName,
    commandName: event.commandName || "",
    logicalToolName: event.logicalToolName || "",
    executionKind: event.executionKind || "",
    taskName: event.taskName || "",
    taskIdPresent: event.taskIdPresent === true,
    startedAtUtc: event.startedAtUtc || "",
    finishedAtUtc: event.finishedAtUtc || "",
    durationMs: event.durationMs ?? null,
    requestBytes: event.requestBytes ?? null,
    responseBytes: event.responseBytes ?? null,
    result,
    groupedEventCount: event.groupedEventCount || null,
    groupedScopes: Array.isArray(event.groupedScopes) ? event.groupedScopes : [],
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

function compactCandidateList(items, limit = 50) {
  return (Array.isArray(items) ? items : [])
    .slice(0, limit)
    .map((item) => ({
      category: item?.category || "",
      signal: item?.signal || "",
      title: item?.title || "",
      count: item?.count || 0,
      promotionReasons: Array.isArray(item?.promotionReasons) ? item.promotionReasons : [],
      candidateAction: item?.candidateAction || "",
      evidenceStrength: item?.evidenceStrength || "",
      humanReviewRequired: item?.humanReviewRequired === true,
      evidenceSnippet: item?.evidenceSnippet || "",
      sessionContext: item?.sessionContext || {},
      toolContext: item?.toolContext || {},
      hash: item?.hash || "",
      toolName: item?.toolName || "",
      scanStoppedReason: item?.scanStoppedReason || "",
      hasManualTransaction: item?.hasManualTransaction === true,
      toolNames: Array.isArray(item?.toolNames) ? item.toolNames : [],
      taskNames: Array.isArray(item?.taskNames) ? item.taskNames : [],
      writePatterns: Array.isArray(item?.writePatterns) ? item.writePatterns : [],
      maxLength: typeof item?.maxLength === "number" ? item.maxLength : 0,
      maxLineCount: typeof item?.maxLineCount === "number" ? item.maxLineCount : 0,
    }));
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
    promotionCandidates: compactCandidateList(summary.promotionCandidates),
    nativeToolCandidates: compactCandidateList(summary.nativeToolCandidates),
    hotfixCandidates: compactCandidateList(summary.hotfixCandidates),
    reconciliationCandidates: compactCandidateList(summary.reconciliationCandidates),
    annotationInventoryCandidates: compactCandidateList(summary.annotationInventoryCandidates),
    evidenceStrength: summary.evidenceStrength || "none",
    humanReviewRequired: summary.humanReviewRequired === true,
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
  const staleSeconds = clampInt(config.staleSeconds, DEFAULT_STALE_SECONDS, 10, 3600);
  const offlineSeconds = clampInt(config.offlineSeconds, DEFAULT_OFFLINE_SECONDS, staleSeconds + 10, 86400);
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
    const latestMachineReport = readJsonFile(path.join(machinesRoot, machineName, "latest.json"));
    // Keep this list aligned with Publish-RevitMcpMachineRunReport:
    // ConvertTo-RevitMcpSafePathSegment($Operation) + "-latest.json".
    const versionCandidateReports = [
      readJsonFile(path.join(machinesRoot, machineName, "update-latest.json")),
      readJsonFile(path.join(machinesRoot, machineName, "reinstall-latest.json")),
      readJsonFile(path.join(machinesRoot, machineName, "install-latest.json")),
      readJsonFile(path.join(machinesRoot, machineName, "source-free-migration-latest.json")),
    ].filter(Boolean);
    const versionReport = chooseVersionReport(latestMachineReport, versionCandidateReports);
    const machineReport = withVersionFallback(latestMachineReport || versionReport, versionReport);
    const liveStatus = mergeLiveStatusCache(
      machineName,
      readJsonFile(path.join(liveRoot, machineName, "status.json")),
      now,
      offlineSeconds,
    );
    const machine = summarizeMachine(machineName, machineReport, liveStatus, stable?.version || "", now, staleSeconds, offlineSeconds);
    const fallbackActivities = chooseRecentActivities(machine.live, machineName, activityByMachine.get(machineName));
    const activeTelemetryActivities = buildStatusActivities(machine.live?.activeTasks || [machine.live?.activeTask].filter(Boolean));
    const activeStatusActivity = enrichRevitStatusActivity(
      revitStatusTaskToActivity(machine.live?.revitStatus?.activeTask, machineName),
      activeTelemetryActivities,
    );
    const displayMachine = machine.live
      ? {
          ...machine,
          live: {
            ...machine.live,
            activeTasks: buildStatusActivities(machine.live.activeTasks || []),
            activeTask: activeStatusActivity ||
              activeTelemetryActivities.find(Boolean) ||
              machine.live.activeTask,
            recentActivity: fallbackActivities.slice(0, 20),
          },
        }
      : machine;
    return withActivityFallback(displayMachine, fallbackActivities);
  });

  const activity = sortActivities(machines.flatMap((machine) => {
    return chooseRecentActivities(machine.live, machine.machine, activityByMachine.get(machine.machine) || []).map((event) => ({
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
    offlineSeconds,
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
    promotionCandidates: Array.isArray(snapshot.summary?.promotionCandidates) ? snapshot.summary.promotionCandidates.slice(0, 20) : [],
    nativeToolCandidates: Array.isArray(snapshot.summary?.nativeToolCandidates) ? snapshot.summary.nativeToolCandidates.slice(0, 20) : [],
    hotfixCandidates: Array.isArray(snapshot.summary?.hotfixCandidates) ? snapshot.summary.hotfixCandidates.slice(0, 20) : [],
    reconciliationCandidates: Array.isArray(snapshot.summary?.reconciliationCandidates) ? snapshot.summary.reconciliationCandidates.slice(0, 20) : [],
    annotationInventoryCandidates: Array.isArray(snapshot.summary?.annotationInventoryCandidates) ? snapshot.summary.annotationInventoryCandidates.slice(0, 20) : [],
    evidenceStrength: snapshot.summary?.evidenceStrength || "none",
    humanReviewRequired: snapshot.summary?.humanReviewRequired === true,
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
  const publicRoot = path.join(__dirname, "..", "public");
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
    "cache-control": "no-store",
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
