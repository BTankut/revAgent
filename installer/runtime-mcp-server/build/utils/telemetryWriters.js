import fs from "node:fs";
import path from "node:path";
const telemetryWriteQueues = new Map();
const liveWriteQueues = new Map();
let liveWritesInFlight = 0;
let liveWritesDropped = 0;
export async function writeJsonFile(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export async function appendJsonLine(filePath, event) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}
export function enqueueAppendJsonLine(filePath, event) {
    const previous = telemetryWriteQueues.get(filePath) || Promise.resolve();
    const write = previous
        .catch(() => undefined)
        .then(() => appendJsonLine(filePath, event));
    telemetryWriteQueues.set(filePath, write);
    write
        .finally(() => {
        if (telemetryWriteQueues.get(filePath) === write) {
            telemetryWriteQueues.delete(filePath);
        }
    })
        .catch(() => undefined);
    return write;
}
export function enqueueLiveWrite(filePath, writer, options) {
    if (options.disabled()) {
        return false;
    }
    if (liveWritesInFlight >= options.maxInFlight()) {
        liveWritesDropped++;
        return false;
    }
    liveWritesInFlight++;
    const previous = liveWriteQueues.get(filePath) || Promise.resolve();
    const write = previous
        .catch(() => undefined)
        .then(() => writer(filePath));
    liveWriteQueues.set(filePath, write);
    write
        .catch(() => {
        liveWritesDropped++;
    })
        .finally(() => {
        if (liveWriteQueues.get(filePath) === write) {
            liveWriteQueues.delete(filePath);
        }
        liveWritesInFlight = Math.max(0, liveWritesInFlight - 1);
    });
    return true;
}
export function getLiveWriteHealth(maxInFlight) {
    return {
        inFlight: liveWritesInFlight,
        dropped: liveWritesDropped,
        maxInFlight,
    };
}
export async function flushLiveWritesForTests(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (liveWritesInFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
export async function flushTelemetryWritesForTests(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (telemetryWriteQueues.size > 0 && Date.now() < deadline) {
        await Promise.allSettled(Array.from(telemetryWriteQueues.values()));
        if (telemetryWriteQueues.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
}
