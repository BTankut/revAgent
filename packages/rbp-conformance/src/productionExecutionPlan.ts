import path from "node:path";

import {
  buildExecutionPlan,
  type ComponentLaunchConfig,
} from "./executionPlan.js";
import type {
  ExecutionPlan,
  ProcessCommandDescriptor,
} from "./types.js";

function command(
  nodeExecutable: string,
  entrypoint: string,
  args: readonly string[],
): ProcessCommandDescriptor {
  return {
    executable: nodeExecutable,
    args: [entrypoint, ...args],
    workingDirectory: ".",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "json", timeoutMs: 15_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 10_000 },
  };
}

/**
 * Canonical production component commands. Paths stay repository-relative so
 * buildExecutionPlan can confine and hash the exact built entrypoints.
 */
export function productionComponentLaunchConfigs(
  repoRoot: string,
  nodeExecutable = process.execPath,
): ComponentLaunchConfig[] {
  const configs: ComponentLaunchConfig[] = [
    {
      id: "gateway_stub",
      version: "0.0.0",
      entrypointPath: "packages/gateway-stub/dist/cli.js",
      command: command(nodeExecutable, "packages/gateway-stub/dist/cli.js", [
        "--state",
        "{{instance_root}}/state/gateway.json",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--control-token",
        "rbp-test-control",
      ]),
    },
    {
      id: "bridge_simulator",
      version: "0.0.0",
      entrypointPath: "packages/bridge-simulator/dist/cli.js",
      command: command(nodeExecutable, "packages/bridge-simulator/dist/cli.js", [
        "daemon",
        "--state-root",
        "{{instance_root}}/state/bridge",
      ]),
    },
    {
      id: "addin_loopback_fixture",
      version: "0.0.0",
      entrypointPath: "packages/addin-loopback-fixture/dist/cli.js",
      command: command(nodeExecutable, "packages/addin-loopback-fixture/dist/cli.js", [
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ]),
    },
  ];
  for (const config of configs) {
    const absolute = path.resolve(repoRoot, config.entrypointPath);
    const relative = path.relative(path.resolve(repoRoot), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`production component path escapes the repository: ${config.entrypointPath}`);
    }
  }
  return configs;
}

/**
 * Builds an executable production plan only from an exactly clean Git tree.
 * resolveSourceIdentity, entrypoint confinement and exact hashes are enforced
 * by buildExecutionPlan.
 */
export function buildProductionExecutionPlan(input: {
  repoRoot: string;
  runId: string;
  sequence: 1 | 2 | 3;
  nodeExecutable?: string;
}): ExecutionPlan {
  return buildExecutionPlan({
    repoRoot: input.repoRoot,
    runId: input.runId,
    sequence: input.sequence,
    components: productionComponentLaunchConfigs(input.repoRoot, input.nodeExecutable),
  });
}
