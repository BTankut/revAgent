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
function hasStableIdentityValue(value) {
    return value !== undefined && value !== null && value !== "";
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
function coalesceMatchingStateField(mergedState, cachedTask, currentTask, field) {
    const targetState = String(mergedState || "").toLowerCase();
    const currentMatches = stateOf(currentTask) === targetState;
    const cachedMatches = stateOf(cachedTask) === targetState;
    if (currentMatches && cachedMatches) {
        return coalesceTaskField(currentTask, cachedTask, field);
    }
    if (currentMatches) {
        return coalesceTaskField(currentTask, null, field);
    }
    if (cachedMatches) {
        return coalesceTaskField(cachedTask, null, field);
    }
    return null;
}
export function revitTaskKey(task, fallback = "") {
    if (!task || typeof task !== "object") {
        return fallback;
    }
    if (hasStableIdentityValue(task.requestId)) {
        return `request:${task.requestId}`;
    }
    if (hasStableIdentityValue(task.id)) {
        return `id:${task.id}`;
    }
    const method = task.method || "";
    const taskName = task.taskName || "";
    const startedAtUtc = task.startedAtUtc || "";
    return method || taskName || startedAtUtc
        ? `task:${method}|${taskName}|${startedAtUtc}`
        : fallback;
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
        merged.finishedAtUtc = coalesceValue(coalesceMatchingStateField(merged.state, cachedTask, currentTask, "finishedAtUtc"), stateSource?.finishedAtUtc);
        merged.elapsedMs = coalesceValue(coalesceMatchingStateField(merged.state, cachedTask, currentTask, "elapsedMs"), stateSource?.elapsedMs);
    }
    else {
        merged.finishedAtUtc = null;
        merged.elapsedMs = null;
    }
    if (stateOf(merged) === "failed") {
        merged.error = coalesceValue(coalesceMatchingStateField(merged.state, cachedTask, currentTask, "error"), chooseFailedErrorSource(cachedTask, currentTask)?.error);
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
