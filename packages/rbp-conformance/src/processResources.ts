import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ResourceSample } from "./types.js";

function procStatus(pid: number): string {
  return readFileSync(`/proc/${pid}/status`, "utf8");
}

function residentBytes(pid: number): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(procStatus(pid));
  if (match === null) throw new Error(`process ${pid} does not expose VmRSS`);
  return Number(match[1]) * 1024;
}

function descriptorCount(pid: number): number {
  return readdirSync(`/proc/${pid}/fd`).length;
}

function directChildren(parentPids: ReadonlySet<number>): number[] {
  const children: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(path.join("/proc", entry, "stat"), "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).split(" ");
      const parent = Number(fields[1]);
      if (parentPids.has(parent)) children.push(Number(entry));
    } catch {
      // A process may exit between directory enumeration and stat read.
    }
  }
  return children;
}

export function assertLinuxProcfs(): void {
  if (process.platform !== "linux" || !existsSync("/proc/self/status")) {
    throw new Error("retained resource evidence requires Linux /proc sampling");
  }
}

export function sampleProcessResources(input: {
  index: number;
  offsetMs: number;
  pids: readonly number[];
  journalPendingCount: number;
}): ResourceSample {
  assertLinuxProcfs();
  const pids = new Set(input.pids);
  const children = directChildren(pids);
  const measured = [...pids, ...children];
  return {
    index: input.index,
    offsetMs: input.offsetMs,
    residentBytes: measured.reduce((sum, pid) => sum + residentBytes(pid), 0),
    openFileDescriptorCount: measured.reduce((sum, pid) => sum + descriptorCount(pid), 0),
    journalPendingCount: input.journalPendingCount,
  };
}

export function survivingProcesses(pids: readonly number[]): number[] {
  if (process.platform !== "linux") {
    throw new Error("orphan process verification requires Linux /proc");
  }
  return pids.filter((pid) => existsSync(`/proc/${pid}`));
}
