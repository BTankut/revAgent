const state = {
  filter: "all",
  data: null,
};

const elements = {
  stableVersion: document.querySelector("#stableVersion"),
  lastRefresh: document.querySelector("#lastRefresh"),
  metricMachines: document.querySelector("#metricMachines"),
  metricLive: document.querySelector("#metricLive"),
  metricActive: document.querySelector("#metricActive"),
  metricOperations: document.querySelector("#metricOperations"),
  metricGuarded: document.querySelector("#metricGuarded"),
  metricFailed: document.querySelector("#metricFailed"),
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
  started: "...",
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
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
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

function attentionState(machine) {
  return ["failed", "deferred", "outdated", "stale", "offline"].includes(machine.state);
}

function shouldShowMachine(machine) {
  if (state.filter === "active") return machine.state === "active";
  if (state.filter === "attention") return attentionState(machine);
  return true;
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

function renderMachines(data) {
  const machines = data.machines || [];
  const visible = machines.filter(shouldShowMachine);
  elements.machineCountLabel.textContent = `${visible.length}/${machines.length} records`;
  if (visible.length === 0) {
    elements.machinesGrid.innerHTML = `<div class="empty">No records.</div>`;
    return;
  }

  elements.machinesGrid.innerHTML = visible.map((machine) => {
    const active = machine.live?.activeTask;
    const task = active
      ? `<strong>${escapeHtml(taskTitle(active))}</strong>`
      : `<span class="muted">${machine.live ? "No active task" : "Waiting for live feed"}</span>`;
    const recent = machine.live?.recentActivity?.[0];
    const recentText = recent ? activityTitle(recent) : "-";
    return `
      <article class="machine-card" data-state="${escapeHtml(machine.state)}">
        <div class="machine-top">
          <div class="machine-name">
            <strong>${escapeHtml(machine.machine)}</strong>
            <span>${escapeHtml(machine.userName || "-")}</span>
          </div>
          <span class="state-pill state-${escapeHtml(machine.state)}">${escapeHtml(stateLabels[machine.state] || machine.state)}</span>
        </div>
        <div class="task-line">${task}</div>
        <div class="machine-facts">
          <div class="fact"><span>Version</span><strong>${escapeHtml(shortVersion(machine.installedVersion || "-"))}</strong></div>
          <div class="fact"><span>Heartbeat</span><strong>${escapeHtml(secondsText(machine.live?.heartbeatAgeSeconds))}</strong></div>
          <div class="fact"><span>Update</span><strong>${escapeHtml(machine.updateStatus || "-")}</strong></div>
          <div class="fact"><span>Last Report</span><strong>${escapeHtml(formatDateTime(machine.atUtc || machine.live?.lastHeartbeatUtc))}</strong></div>
        </div>
        <div class="task-line"><span class="muted">${escapeHtml(recentText)}</span></div>
      </article>
    `;
  }).join("");
}

function renderActivity(data) {
  const activity = data.activity || [];
  elements.activityCountLabel.textContent = `${activity.length} records`;
  if (activity.length === 0) {
    elements.activityList.innerHTML = `<div class="empty">Waiting for live activity.</div>`;
    return;
  }

  elements.activityList.innerHTML = activity.slice(0, 120).map((event) => {
    const phase = event.phase || event.state || "completed";
    const symbolClass = phase === "started" ? "started" : phase === "guarded" ? "guarded" : phase === "failed" ? "failed" : "completed";
    return `
      <div class="activity-row">
        <div class="activity-symbol symbol-${symbolClass}">${escapeHtml(phaseSymbols[phase] || "OK")}</div>
        <div class="activity-main">
          <div class="activity-title">${escapeHtml(activityTitle(event))}</div>
          <div class="activity-meta">
            <span>${escapeHtml(event.machineName || "-")}</span>
            <span>${escapeHtml(event.toolName || event.commandName || event.scope || "-")}</span>
            <span>${escapeHtml(formatTime(event.timestampUtc || event.finishedAtUtc || event.startedAtUtc))}</span>
            <span>${event.durationMs !== undefined && event.durationMs !== null ? `${escapeHtml(event.durationMs)} ms` : ""}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
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
  const events = frictionEvents(data.summary).slice(0, 24);
  elements.frictionLabel.textContent = `${events.length} records`;
  if (events.length === 0) {
    elements.frictionList.innerHTML = `<div class="empty">No friction records.</div>`;
    return;
  }
  elements.frictionList.innerHTML = events.map((event) => {
    const phase = event.phase || "completed";
    const symbolClass = phase === "guarded" ? "guarded" : phase === "failed" ? "failed" : "started";
    return `
      <div class="activity-row">
        <div class="activity-symbol symbol-${symbolClass}">${escapeHtml(phaseSymbols[phase] || "...")}</div>
        <div class="activity-main">
          <div class="activity-title">${escapeHtml(event.taskName || event.tool || "-")}</div>
          <div class="activity-meta">
            <span>${escapeHtml(event.machineName || "-")}</span>
            <span>${escapeHtml(event.tool || "-")}</span>
            <span>${escapeHtml(event.durationMs ? `${event.durationMs} ms` : formatTime(event.timestampUtc))}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function render(data) {
  state.data = data;
  renderMetrics(data);
  renderMachines(data);
  renderActivity(data);
  renderTools(data);
  renderFriction(data);
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

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    state.filter = button.dataset.filter || "all";
    if (state.data) {
      renderMachines(state.data);
    }
  });
});

await refresh();
setInterval(refresh, 3000);
