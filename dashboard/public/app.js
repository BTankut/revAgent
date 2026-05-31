const THEME_STORAGE_KEY = "revagent.dashboard.theme";
const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_EXPANDED_LIMIT = 200;
const REFRESH_TIMEOUT_MS = 8000;
const SCROLL_TOP_THRESHOLD_PX = 4;

const state = {
  data: null,
  themeChoice: localStorage.getItem(THEME_STORAGE_KEY) || "system",
  activityExpanded: false,
  refreshInFlight: false,
  selectedMachines: null,
  hasRendered: false,
  activityScrollTop: 0,
  activityScrollHeight: 0,
  activityScrollAwayFromTop: false,
  suppressActivityScrollTracking: false,
};

const elements = {
  stableVersion: document.querySelector("#stableVersion"),
  lastRefresh: document.querySelector("#lastRefresh"),
  themeButtons: document.querySelectorAll("[data-theme-choice]"),
  machineCountLabel: document.querySelector("#machineCountLabel"),
  machinesGrid: document.querySelector("#machinesGrid"),
  activityCountLabel: document.querySelector("#activityCountLabel"),
  activityFilters: document.querySelector("#activityFilters"),
  activityList: document.querySelector("#activityList"),
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

const statusMarks = {
  started: "...",
  completed: "\u2713",
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

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  const seconds = ms / 1000;
  const decimals = seconds < 1 ? 2 : seconds < 10 ? 1 : 0;
  const text = seconds.toFixed(decimals).replace(/\.?0+$/, "");
  return `${text || "0"} s`;
}

function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  const decimals = kb < 10 ? 1 : 0;
  return `${kb.toFixed(decimals).replace(/\.?0+$/, "")} KB`;
}

function eventPayloadBytes(event) {
  if (event.responseBytes !== undefined && event.responseBytes !== null) {
    return event.responseBytes;
  }
  if (event.requestBytes !== undefined && event.requestBytes !== null) {
    return event.requestBytes;
  }
  return null;
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

function statusEvents(events, limit) {
  return [...(events || [])]
    .filter(Boolean)
    .sort((a, b) => String(eventTimestamp(b)).localeCompare(String(eventTimestamp(a))))
    .slice(0, limit);
}

function phaseOf(event) {
  const phase = event.phase || event.state || "completed";
  if (phase === "running") return "started";
  if (phase === "blocked") return "guarded";
  return phase;
}

function durationLabel(event) {
  const bytes = formatBytes(eventPayloadBytes(event));
  const suffix = bytes ? ` [${bytes}]` : "";
  if (event.durationMs !== undefined && event.durationMs !== null) {
    return `${formatDurationMs(event.durationMs)}${suffix}`;
  }
  if (phaseOf(event) === "started") {
    return `running${suffix}`;
  }
  return `${event.state || event.phase || ""}${suffix}`;
}

function renderStatusLine(event, options = {}) {
  const phase = phaseOf(event);
  const scope = event.toolName || event.commandName || event.tool || event.scope || "-";
  const machine = options.showMachine ? `<span class="status-machine">${escapeHtml(event.machineName || "-")}</span>` : "";
  return `
    <div class="status-line status-${escapeHtml(phase)}">
      <span class="status-time">${escapeHtml(formatTime(eventTimestamp(event)))}</span>
      <span class="status-mark">${escapeHtml(statusMarks[phase] || "?")}</span>
      ${machine}
      <span class="status-task">${escapeHtml(activityTitle(event))}</span>
      <span class="status-scope">${escapeHtml(scope)}</span>
      <span class="status-duration">${escapeHtml(durationLabel(event))}</span>
    </div>
  `;
}

function normalizeMachineName(value) {
  return String(value || "").trim().toUpperCase();
}

function allMachineNames(data) {
  return (data.machines || [])
    .map((machine) => normalizeMachineName(machine.machine))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function selectedMachineSet(data) {
  if (state.selectedMachines === null) {
    return null;
  }
  const valid = new Set(allMachineNames(data));
  return new Set([...state.selectedMachines].filter((name) => valid.has(name)));
}

function isMachineSelected(machineName, data) {
  const selected = selectedMachineSet(data);
  return selected === null || selected.has(normalizeMachineName(machineName));
}

function filteredActivity(data) {
  const selected = selectedMachineSet(data);
  const activity = statusEvents(data.activity || [], ACTIVITY_EXPANDED_LIMIT);
  if (selected === null) {
    return activity;
  }
  return activity.filter((event) => selected.has(normalizeMachineName(event.machineName)));
}

function resolveTheme(choice) {
  if (choice === "light" || choice === "dark") {
    return choice;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  const choice = ["system", "light", "dark"].includes(state.themeChoice) ? state.themeChoice : "system";
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = choice;
  elements.themeButtons.forEach((button) => {
    const active = button.dataset.themeChoice === choice;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderHeader(data) {
  elements.stableVersion.textContent = `Stable ${data.stable?.version || "-"}`;
  elements.lastRefresh.textContent = `Refresh ${formatTime(data.generatedAtUtc)}`;
}

function renderMachineFilters(data) {
  const machines = allMachineNames(data);
  const selected = selectedMachineSet(data);
  const allSelected = selected === null;
  const selectedCount = allSelected ? machines.length : selected.size;
  const machineButtons = machines.map((machineName) => {
    const active = allSelected || selected.has(machineName);
    return `
      <button class="filter-chip${active ? " is-active" : ""}" type="button" data-filter-machine="${escapeHtml(machineName)}" aria-pressed="${active ? "true" : "false"}">
        ${escapeHtml(machineName)}
      </button>
    `;
  }).join("");

  elements.activityFilters.innerHTML = `
    <button class="filter-chip filter-all${allSelected ? " is-active" : ""}" type="button" data-filter-all aria-pressed="${allSelected ? "true" : "false"}">
      All machines
    </button>
    ${machineButtons}
    <span class="filter-count">${escapeHtml(selectedCount)} selected</span>
  `;
}

function renderMachines(data) {
  const machines = data.machines || [];
  elements.machineCountLabel.textContent = `${machines.length} machines`;
  if (machines.length === 0) {
    elements.machinesGrid.innerHTML = `<div class="empty">No machine records.</div>`;
    return;
  }

  elements.machinesGrid.innerHTML = machines.map((machine) => {
    const selectedSet = selectedMachineSet(data);
    const selected = selectedSet !== null && selectedSet.has(normalizeMachineName(machine.machine));
    const lastSeen = formatDateTime(machine.live?.lastHeartbeatUtc || machine.atUtc);
    return `
      <article class="machine-card${selected ? " is-selected" : ""}" data-state="${escapeHtml(machine.state)}" data-machine="${escapeHtml(machine.machine)}">
        <div class="machine-top">
          <div class="machine-name">
            <strong>${escapeHtml(machine.machine)}</strong>
            <span>${escapeHtml(machine.userName || "-")}</span>
          </div>
          <div class="machine-actions">
            <span class="state-pill state-${escapeHtml(machine.state)}">${escapeHtml(stateLabels[machine.state] || machine.state)}</span>
            <button class="monitor-button${selected ? " is-active" : ""}" type="button" data-monitor-machine="${escapeHtml(machine.machine)}">${selected ? "Selected" : "Monitor"}</button>
          </div>
        </div>
        <div class="machine-meta">
          <span><strong>Version</strong> ${escapeHtml(shortVersion(machine.installedVersion || "-"))}</span>
          <span><strong>Last seen</strong> ${escapeHtml(lastSeen)}</span>
        </div>
      </article>
    `;
  }).join("");
}

function renderActivity(data) {
  renderMachineFilters(data);
  const activity = filteredActivity(data);
  const visibleActivity = state.activityExpanded ? activity : activity.slice(0, ACTIVITY_DEFAULT_LIMIT);
  elements.activityCountLabel.textContent = `${visibleActivity.length} of ${activity.length} selected records`;
  if (activity.length === 0) {
    elements.activityList.innerHTML = `<div class="status-empty">No activity for the selected machines.</div>`;
    return;
  }

  const canExpand = activity.length > ACTIVITY_DEFAULT_LIMIT;
  const hiddenCount = Math.max(activity.length - ACTIVITY_DEFAULT_LIMIT, 0);
  const toggleButton = canExpand
    ? `
      <button class="activity-expand-button" type="button" data-activity-toggle aria-expanded="${state.activityExpanded ? "true" : "false"}">
        <span class="expand-chevron${state.activityExpanded ? " is-open" : ""}" aria-hidden="true"></span>
        <span>${state.activityExpanded ? `Show latest ${ACTIVITY_DEFAULT_LIMIT} records` : `Show ${hiddenCount} older records`}</span>
      </button>
    `
    : "";

  elements.activityList.innerHTML = `
    <div class="status-title">Recent tasks</div>
    <div class="status-list">${visibleActivity.map((event) => renderStatusLine(event, { showMachine: true })).join("")}</div>
    ${toggleButton}
  `;
}

function setMachineFilter(machineName) {
  const normalized = normalizeMachineName(machineName);
  if (!normalized || !state.data) return;
  const machines = allMachineNames(state.data);
  if (state.selectedMachines === null) {
    state.selectedMachines = new Set([normalized]);
  } else if (state.selectedMachines.has(normalized)) {
    state.selectedMachines.delete(normalized);
  } else {
    state.selectedMachines.add(normalized);
  }
  if (state.selectedMachines.size === machines.length) {
    state.selectedMachines = null;
  }
  state.activityExpanded = false;
}

function captureActivityScroll() {
  const element = elements.activityList;
  const trackedTop = state.activityScrollAwayFromTop ? state.activityScrollTop : element.scrollTop;
  const trackedHeight = state.activityScrollAwayFromTop ? state.activityScrollHeight : element.scrollHeight;
  return {
    scrollTop: trackedTop,
    scrollHeight: trackedHeight,
    isAtTop: trackedTop <= SCROLL_TOP_THRESHOLD_PX,
  };
}

function restoreActivityScroll(snapshot, options = {}) {
  const element = elements.activityList;
  state.suppressActivityScrollTracking = true;
  if (options.reset || !snapshot || snapshot.isAtTop) {
    element.scrollTop = 0;
    state.activityScrollTop = 0;
    state.activityScrollHeight = element.scrollHeight;
    state.activityScrollAwayFromTop = false;
    window.setTimeout(() => {
      state.suppressActivityScrollTracking = false;
    }, 0);
    return;
  }

  const heightDelta = Math.max(0, element.scrollHeight - snapshot.scrollHeight);
  element.scrollTop = snapshot.scrollTop + heightDelta;
  state.activityScrollTop = element.scrollTop;
  state.activityScrollHeight = element.scrollHeight;
  state.activityScrollAwayFromTop = element.scrollTop > SCROLL_TOP_THRESHOLD_PX;
  window.setTimeout(() => {
    state.suppressActivityScrollTracking = false;
  }, 0);
}

function resetActivityScroll() {
  state.suppressActivityScrollTracking = true;
  elements.activityList.scrollTop = 0;
  state.activityScrollTop = 0;
  state.activityScrollHeight = elements.activityList.scrollHeight;
  state.activityScrollAwayFromTop = false;
  window.setTimeout(() => {
    state.suppressActivityScrollTracking = false;
  }, 0);
}

function render(data, options = {}) {
  const scrollSnapshot = captureActivityScroll();
  state.data = data;
  renderHeader(data);
  renderMachines(data);
  renderActivity(data);
  restoreActivityScroll(scrollSnapshot, {
    reset: options.resetActivityScroll || !state.hasRendered,
  });
  state.hasRendered = true;
}

async function refresh() {
  if (state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const response = await fetch("/api/overview", { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    render(await response.json());
  } catch {
    elements.lastRefresh.textContent = `Connection error ${formatTime(new Date().toISOString())}`;
  } finally {
    window.clearTimeout(timeout);
    state.refreshInFlight = false;
  }
}

elements.themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.themeChoice = button.dataset.themeChoice || "system";
    localStorage.setItem(THEME_STORAGE_KEY, state.themeChoice);
    applyTheme();
  });
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.themeChoice === "system") {
    applyTheme();
  }
});

elements.machinesGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-monitor-machine]");
  if (!button) {
    return;
  }
  setMachineFilter(button.getAttribute("data-monitor-machine"));
  if (state.data) {
    renderMachines(state.data);
    renderActivity(state.data);
    resetActivityScroll();
  }
});

elements.activityFilters.addEventListener("click", (event) => {
  const allButton = event.target.closest("[data-filter-all]");
  if (allButton) {
    state.selectedMachines = null;
    state.activityExpanded = false;
    if (state.data) {
      renderMachines(state.data);
      renderActivity(state.data);
      resetActivityScroll();
    }
    return;
  }

  const machineButton = event.target.closest("[data-filter-machine]");
  if (!machineButton) {
    return;
  }
  setMachineFilter(machineButton.getAttribute("data-filter-machine"));
  if (state.data) {
    renderMachines(state.data);
    renderActivity(state.data);
    resetActivityScroll();
  }
});

elements.activityList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-activity-toggle]");
  if (!button) {
    return;
  }
  state.activityExpanded = !state.activityExpanded;
  if (state.data) {
    renderActivity(state.data);
    resetActivityScroll();
  }
});

elements.activityList.addEventListener("scroll", () => {
  if (state.suppressActivityScrollTracking) {
    return;
  }
  state.activityScrollTop = elements.activityList.scrollTop;
  state.activityScrollHeight = elements.activityList.scrollHeight;
  state.activityScrollAwayFromTop = elements.activityList.scrollTop > SCROLL_TOP_THRESHOLD_PX;
});

applyTheme();
await refresh();
setInterval(refresh, 3000);
