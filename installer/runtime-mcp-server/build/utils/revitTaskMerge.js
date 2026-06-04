const TERMINAL_STATES = new Set(["completed", "failed", "guarded"]);
export function coalesceTaskField(primary, secondary, field) {
    return primary?.[field] !== undefined && primary?.[field] !== null
        ? primary[field]
        : secondary?.[field] ?? null;
}
function coalesceValue(primary, secondary) {
    return primary !== undefined && primary !== null ? primary : secondary ?? null;
}
function stateOf(task) {
    return String(task?.state || "").toLowerCase();
}
function isTerminalState(value) {
    return TERMINAL_STATES.has(String(value || "").toLowerCase());
}
function taskTimestampMs(task) {
    const ms = Date.parse(String(task?.finishedAtUtc || task?.startedAtUtc || ""));
    return Number.isFinite(ms) ? ms : 0;
}
function chooseStateSource(cachedTask, currentTask) {
    const currentTerminal = isTerminalState(currentTask?.state);
    const cachedTerminal = isTerminalState(cachedTask?.state);
    if (currentTerminal) {
        return currentTask || null;
    }
    if (cachedTerminal) {
        return cachedTask || null;
    }
    return currentTask || cachedTask || null;
}
function chooseFailedErrorSource(cachedTask, currentTask) {
    if (stateOf(currentTask) === "failed") {
        return currentTask || null;
    }
    if (stateOf(cachedTask) === "failed") {
        return cachedTask || null;
    }
    return null;
}
export function revitTaskKey(task, fallback = "") {
    if (!task || typeof task !== "object") {
        return fallback;
    }
    if (task.requestId) {
        return `request:${task.requestId}`;
    }
    if (task.id) {
        return `id:${task.id}`;
    }
    const parts = [
        task.method || "",
        task.taskName || "",
        task.startedAtUtc || "",
    ];
    const key = parts.join("|");
    return key.replace(/\|/g, "") ? `task:${key}` : fallback;
}
export function mergeRevitTask(cachedTask, currentTask) {
    const stateSource = chooseStateSource(cachedTask, currentTask);
    const merged = {
        ...(cachedTask || {}),
        ...(currentTask || {}),
    };
    for (const field of ["id", "requestId", "method", "taskName", "startedAtUtc", "requestBytes", "responseBytes", "port"]) {
        merged[field] = coalesceTaskField(currentTask, cachedTask, field);
    }
    merged.state = coalesceValue(stateSource?.state, coalesceTaskField(currentTask, cachedTask, "state"));
    if (isTerminalState(merged.state)) {
        merged.finishedAtUtc = coalesceValue(stateSource?.finishedAtUtc, null);
        merged.elapsedMs = coalesceValue(stateSource?.elapsedMs, null);
    }
    else {
        merged.finishedAtUtc = null;
        merged.elapsedMs = null;
    }
    if (stateOf({ state: merged.state }) === "failed") {
        merged.error = coalesceValue(chooseFailedErrorSource(cachedTask, currentTask)?.error, null);
    }
    else {
        merged.error = null;
    }
    return merged;
}
export function mergeRecentRevitTasks(currentTasks, cachedTasks, limit = 100) {
    const maxTasks = Math.max(1, Math.min(200, Number(limit) || 100));
    const keyed = new Map();
    const addTasks = (tasks, prefix) => {
        for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
            if (!task || typeof task !== "object") {
                continue;
            }
            const key = revitTaskKey(task, `${prefix}:${index}`);
            const existing = keyed.get(key);
            keyed.set(key, existing ? mergeRevitTask(existing, task) : task);
        }
    };
    addTasks(cachedTasks, "cached");
    addTasks(currentTasks, "current");
    return [...keyed.values()]
        .sort((a, b) => taskTimestampMs(b) - taskTimestampMs(a))
        .slice(0, maxTasks);
}
export function mergeRevitStatusSnapshots(currentRevitStatus, cachedRevitStatus) {
    const current = currentRevitStatus && typeof currentRevitStatus === "object" ? currentRevitStatus : null;
    const cached = cachedRevitStatus && typeof cachedRevitStatus === "object" ? cachedRevitStatus : null;
    if (!current && !cached) {
        return null;
    }
    const recentHistoryCapacity = current?.recentHistoryCapacity ?? cached?.recentHistoryCapacity ?? 100;
    const recentTasks = mergeRecentRevitTasks(current?.recentTasks, cached?.recentTasks, recentHistoryCapacity);
    const recentHistoryCount = Math.max(Number(current?.recentHistoryCount) || 0, Number(cached?.recentHistoryCount) || 0, recentTasks.length);
    return {
        ...(cached || {}),
        ...(current || {}),
        activeTask: current?.activeTask || null,
        recentTasks,
        recentHistoryCount,
        recentHistoryCapacity,
    };
}
export function unexpiredCachedRevitStatus(cachedEntry, now, cacheTtlMs) {
    return cachedEntry && now - cachedEntry.cachedAtMs <= cacheTtlMs
        ? cachedEntry.revitStatus
        : null;
}
