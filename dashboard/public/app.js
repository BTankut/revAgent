const state = {
  focusMachine: null,
  data: null,
};

const elements = {
  stableVersion: document.querySelector("#stableVersion"),
  lastRefresh: document.querySelector("#lastRefresh"),
  focusLabel: document.querySelector("#focusLabel"),
  clearFocusButton: document.querySelector("#clearFocusButton"),
  metricMachines: document.querySelector("#metricMachines"),
  metricLive: document.querySelector("#metricLive"),
  metricActive: document.querySelector("#metricActive"),
  metricOperations: document.querySelector("#metricOperations"),
  metricGuarded: document.querySelector("#metricGuarded"),
  metricFailed: document.querySelector("#metricFailed"),
  terminalLayout: document.querySelector("#terminalLayout"),
  machineCountLabel: document.querySelector("#machineCountLabel"),
  machinesGrid: document.querySelector("#machinesGrid"),
  activityCountLabel: document.querySelector("#activityCountLabel"),
  activityList: document.querySelector("#activityList"),
  summaryDateLabel: document.querySelector("#summaryDateLabel"),
  toolsTable: document.querySelector("#toolsTable"),
  frictionLabel: document.querySelector("#frictionLabel"),
  frictionList: document.querySelector("#frictionList"),
};

const stateLabels = {
  active: "Active",
  online: "Live",
  current: "Current",
  stale: "Stale",
  offline: "Offline",
  failed: "Failed",
  deferred: "Deferred",
  outdated: "Outdated",
};

const phaseSymbols = {
  started: ">",
  completed: "OK",
  guarded: "!",
  failed: "X",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(value) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortVersion(value) {
  const text = String(value || "");
  return text.replace(/^20/, "").replace(/-([0-9a-f]{8}).*$/i, "-$1");
}

function secondsText(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h`;
}

function taskTitle(task) {
  if (!task) return "";
  return task.taskName || task.toolName || task.commandName || task.logicalToolName || "revAgent task";
}

function activityTitle(event) {
  return event.taskName || event.toolName || event.commandName || event.logicalToolName || "revAgent activity";
}

function eventTimestamp(event) {
  return event.timestampUtc || event.finishedAtUtc || event.startedAtUtc || "";
}

function terminalEvents(events, limit) {
  return [...(events || [])]
    .filter(Boolean)
    .sort((a, b) => String(eventTimestamp(a)).localeCompare(String(eventTimestamp(b))))
    .slice(-limit);
}

function resultLabel(event) {
  if (event.durationMs !== undefined && event.durationMs !== null) {
    return `${event.durationMs} ms`;
  }
  if (event.state) {
    return event.state;
  }
  return event.phase || "";
}

function renderTerminalLine(event, options = {}) {
  const phase = event.phase || event.state || "completed";
  const symbolClass = phase === "started" ? "started" : phase === "guarded" ? "guarded" : phase === "failed" ? "failed" : "completed";
  const scope = event.toolName || event.commandName || event.tool || event.scope || "-";
  const machine = options.showMachine ? `<span class="terminal-machine">${escapeHtml(event.machineName || "-")}</span>` : "";
  return `
    <div class="terminal-line terminal-${symbolClass}">
      <span class="terminal-time">${escapeHtml(formatTime(eventTimestamp(event)))}</span>
      <span class="terminal-symbol">${escapeHtml(phaseSymbols[phase] || "OK")}</span>
      ${machine}
      <span class="terminal-scope">${escapeHtml(scope)}</span>
      <span class="terminal-title">${escapeHtml(activityTitle(event))}</span>
      <span class="terminal-result">${escapeHtml(resultLabel(event))}</span>
    </div>
  `;
}

function machineEvents(machine) {
  return terminalEvents(machine.live?.recentActivity || [], state.focusMachine ? 120 : 24);
}

function visibleMachines(data) {
  const machines = data.machines || [];
  if (!state.focusMachine) {
    return machines;
  }
  return machines.filter((machine) => machine.machine === state.focusMachine);
}

function renderMetrics(data) {
  const overview = data.overview || {};
  elements.metricMachines.textContent = overview.machineCount || 0;
  elements.metricLive.textContent = overview.liveMachineCount || 0;
  elements.metricActive.textContent = overview.activeMachineCount || 0;
  elements.metricOperations.textContent = overview.productionOperationCount || 0;
  elements.metricGuarded.textContent = overview.guardedCount || 0;
  elements.metricFailed.textContent = overview.failedCount || 0;
  elements.stableVersion.textContent = `Stable ${data.stable?.version || "-"}`;
  elements.lastRefresh.textContent = `Refresh ${formatTime(data.generatedAtUtc)}`;
}

function renderFocusState() {
  const focused = Boolean(state.focusMachine);
  document.body.classList.toggle("focus-mode", focused);
  elements.terminalLayout.classList.toggle("focus-mode", focused);
  elements.clearFocusButton.hidden = !focused;
  elements.focusLabel.hidden = !focused;
  elements.focusLabel.textContent = focused ? `Focus ${state.focusMachine}` : "";
}

function renderMachines(data) {
  renderFocusState();
  const machines = data.machines || [];
  const visible = visibleMachines(data);
  elements.machineCountLabel.textContent = `${visible.length}/${machines.length} machines`;
  if (visible.length === 0) {
    elements.machinesGrid.innerHTML = `<div class="empty">No machine records.</div>`;
    return;
  }

  elements.machinesGrid.innerHTML = visible.map((machine) => {
    const active = machine.live?.activeTask;
    const activeTask = active
      ? `<strong>${escapeHtml(taskTitle(active))}</strong>`
      : `<span class="muted">${machine.live ? "Idle" : "Waiting for live feed"}</span>`;
    const events = machineEvents(machine);
    const terminal = events.length > 0
      ? events.map((event) => renderTerminalLine({ ...event, machineName: event.machineName || machine.machine })).join("")
      : `<div class="terminal-empty">No activity yet.</div>`;
    return `
      <article class="machine-card terminal-card" data-state="${escapeHtml(machine.state)}" data-machine="${escapeHtml(machine.machine)}">
        <div class="machine-top">
          <div class="machine-name">
            <strong>${escapeHtml(machine.machine)}</strong>
            <span>${escapeHtml(machine.userName || "-")}</span>
          </div>
          <div class="machine-actions">
            <span class="state-pill state-${escapeHtml(machine.state)}">${escapeHtml(stateLabels[machine.state] || machine.state)}</span>
            <button class="focus-button" type="button" data-focus-machine="${escapeHtml(machine.machine)}">${state.focusMachine ? "All" : "Focus"}</button>
          </div>
        </div>
        <div class="active-task">${activeTask}</div>
        <div class="machine-facts">
          <div class="fact"><span>Version</span><strong>${escapeHtml(shortVersion(machine.installedVersion || "-"))}</strong></div>
          <div class="fact"><span>Heartbeat</span><strong>${escapeHtml(secondsText(machine.live?.heartbeatAgeSeconds))}</strong></div>
          <div class="fact"><span>Update</span><strong>${escapeHtml(machine.updateStatus || "-")}</strong></div>
          <div class="fact"><span>Last Report</span><strong>${escapeHtml(formatDateTime(machine.atUtc || machine.live?.lastHeartbeatUtc))}</strong></div>
        </div>
        <div class="terminal-window machine-terminal">${terminal}</div>
      </article>
    `;
  }).join("");
}

function renderActivity(data) {
  const activity = terminalEvents(data.activity || [], 220);
  elements.activityCountLabel.textContent = `${(data.activity || []).length} records`;
  if (activity.length === 0) {
    elements.activityList.innerHTML = `<div class="terminal-empty">Waiting for live activity.</div>`;
    return;
  }

  elements.activityList.innerHTML = activity.map((event) => renderTerminalLine(event, { showMachine: true })).join("");
}

function renderTools(data) {
  const summary = data.summary || {};
  const tools = Array.isArray(summary.toolUsage) ? summary.toolUsage.slice(0, 12) : [];
  elements.summaryDateLabel.textContent = summary.dateUtc || "-";
  if (tools.length === 0) {
    elements.toolsTable.innerHTML = `<div class="empty">No tool usage.</div>`;
    return;
  }

  elements.toolsTable.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Count</th>
          <th>OK</th>
          <th>Guarded</th>
          <th>Failed</th>
          <th>Avg ms</th>
        </tr>
      </thead>
      <tbody>
        ${tools.map((tool) => `
          <tr>
            <td>${escapeHtml(tool.name || "-")}</td>
            <td>${escapeHtml(tool.count || 0)}</td>
            <td>${escapeHtml(tool.successCount || 0)}</td>
            <td>${escapeHtml(tool.guardedCount || 0)}</td>
            <td>${escapeHtml(tool.failedCount || 0)}</td>
            <td>${escapeHtml(tool.averageDurationMs || 0)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function frictionEvents(summary) {
  const friction = summary?.friction || {};
  return [
    ...(Array.isArray(friction.failed) ? friction.failed.map((item) => ({ ...item, phase: "failed" })) : []),
    ...(Array.isArray(friction.guarded) ? friction.guarded.map((item) => ({ ...item, phase: "guarded" })) : []),
    ...(Array.isArray(friction.slow) ? friction.slow.slice(0, 10).map((item) => ({ ...item, phase: "started" })) : []),
  ];
}

function renderFriction(data) {
  const events = terminalEvents(frictionEvents(data.summary), 32);
  elements.frictionLabel.textContent = `${events.length} records`;
  if (events.length === 0) {
    elements.frictionList.innerHTML = `<div class="terminal-empty">No friction records.</div>`;
    return;
  }
  elements.frictionList.innerHTML = events.map((event) => renderTerminalLine(event, { showMachine: true })).join("");
}

function scrollTerminalsToBottom() {
  document.querySelectorAll(".terminal-window").forEach((terminal) => {
    terminal.scrollTop = terminal.scrollHeight;
  });
}

function render(data) {
  state.data = data;
  renderMetrics(data);
  renderMachines(data);
  renderActivity(data);
  renderTools(data);
  renderFriction(data);
  scrollTerminalsToBottom();
}

async function refresh() {
  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    render(await response.json());
  } catch (error) {
    elements.lastRefresh.textContent = `Connection error ${formatTime(new Date().toISOString())}`;
  }
}

elements.machinesGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-focus-machine]");
  if (!button) {
    return;
  }

  const machine = button.getAttribute("data-focus-machine");
  state.focusMachine = state.focusMachine === machine ? null : machine;
  if (state.data) {
    render(state.data);
  }
});

elements.clearFocusButton.addEventListener("click", () => {
  state.focusMachine = null;
  if (state.data) {
    render(state.data);
  }
});

await refresh();
setInterval(refresh, 3000);
