import type { RunStatus } from "./types.js";

export type RunClassification = "passed" | "failed" | "incomplete";

export function classifyRunStatus(status: RunStatus): RunClassification {
  if (status === "initialized" || status === "running") {
    return "incomplete";
  }
  return status === "passed" ? "passed" : "failed";
}
