import type {
  CaseStackSupervisor,
  GatewayStartupOverrides,
} from "./caseStackSupervisor.js";
import type {
  ParentStepDriver,
  ParentStepDrivers,
  RawStepOutcome,
} from "./parentStepEngine.js";
import type { JsonObject } from "./processHarness.js";
import { createProductionCaseDrivers } from "./productionDrivers.js";
import {
  createRawHttpSseBindingDriver,
  createRawWssBindingDriver,
  type RawBindingTlsTrust,
} from "./rawBindingDrivers.js";
import type { ComponentId } from "./types.js";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function tlsTrust(value: unknown): RawBindingTlsTrust {
  if (!isObject(value) || value.enabled !== true) {
    throw new Error("raw WSS binding requires active current-stack TLS trust");
  }
  return {
    caCertificatePath: requiredString(value.caCertificatePath, "CA certificate path"),
    caCertificateSha256: requiredString(value.caCertificateSha256, "CA certificate digest"),
    serverCertificateSha256: requiredString(
      value.serverCertificateSha256,
      "server certificate digest",
    ),
  };
}

function startupOverrides(value: unknown): GatewayStartupOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("restart_component startupOverrides must be an object");
  const stringList = (name: string): string[] | undefined => {
    const selected = value[name];
    if (selected === undefined) return undefined;
    if (!Array.isArray(selected) || selected.some((entry) => typeof entry !== "string")) {
      throw new Error(`restart_component startupOverrides.${name} must be a string array`);
    }
    return [...selected] as string[];
  };
  const protocols = value.supportedProtocols;
  if (
    protocols !== undefined &&
    (!Array.isArray(protocols) ||
      protocols.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 1))
  ) {
    throw new Error("restart_component supportedProtocols must be positive safe integers");
  }
  const clockStartMs = value.clockStartMs;
  if (
    clockStartMs !== undefined &&
    (!Number.isSafeInteger(clockStartMs) || Number(clockStartMs) < 0)
  ) {
    throw new Error("restart_component clockStartMs must be a non-negative safe integer");
  }
  return {
    sessionCapabilities: stringList("sessionCapabilities"),
    connectionCapabilities: stringList("connectionCapabilities"),
    supportedProtocols: protocols === undefined ? undefined : protocols.map(Number),
    clockStartMs: clockStartMs === undefined ? undefined : Number(clockStartMs),
  };
}

function success(
  result: JsonObject,
  observations: Awaited<ReturnType<CaseStackSupervisor["restartComponent"]>>["observations"] = [],
): RawStepOutcome {
  return {
    kind: "success",
    result,
    ...(observations.length === 0 ? {} : { observations }),
  };
}

function rawBindingDriver(supervisor: CaseStackSupervisor, token: string, binding: string): ParentStepDriver {
  const endpoint = supervisor.rawBindingEndpoint();
  if (binding === "wss") {
    return createRawWssBindingDriver({
      url: requiredString(endpoint.wsUrl, "raw WSS URL"),
      deviceToken: token,
      tlsTrust: tlsTrust(endpoint.tlsTrust),
      limits: { settleMs: 250 },
    });
  }
  if (binding === "streamable_http_sse") {
    return createRawHttpSseBindingDriver({
      connectionUrl: requiredString(endpoint.httpConnectionUrl, "raw HTTP connection URL"),
      deviceToken: token,
      limits: { settleMs: 250 },
    });
  }
  throw new Error(`unsupported raw binding ${binding}`);
}

function earlyHarnessDriver(
  supervisor: CaseStackSupervisor,
  base: ParentStepDriver,
): ParentStepDriver {
  return async (request) => {
    if (request.action === "send_binding_frame") {
      const token = typeof request.arguments.credential === "string"
        ? request.arguments.credential
        : "test-device-token";
      return await rawBindingDriver(supervisor, token, request.binding)(request);
    }
    if (request.action === "restart_component") {
      const componentId = requiredString(
        request.arguments.componentId,
        "restart_component componentId",
      );
      if (!["gateway_stub", "bridge_simulator", "addin_loopback_fixture"].includes(componentId)) {
        throw new Error("restart_component componentId is unknown");
      }
      const transportSecurity = request.arguments.transportSecurity;
      if (
        transportSecurity !== undefined &&
        transportSecurity !== "preserve" &&
        transportSecurity !== "cleartext_loopback"
      ) {
        throw new Error(
          "restart_component transportSecurity must be preserve or cleartext_loopback",
        );
      }
      const restarted = await supervisor.restartComponent({
        componentId: componentId as ComponentId,
        preserveState: request.arguments.preserveState === true,
        startupOverrides: startupOverrides(request.arguments.startupOverrides),
        ...(transportSecurity === undefined ? {} : { transportSecurity }),
      }, request.stepId, request.action);
      return success(restarted.result, restarted.observations);
    }
    if (
      request.action === "spawn_fixture_bind_probe" &&
      request.arguments.mode === "fixture_session"
    ) {
      const count = request.arguments.count === undefined
        ? 1
        : Number(request.arguments.count);
      if (!Number.isSafeInteger(count) || count < 1 || count > 3) {
        throw new Error("spawn_fixture_bind_probe count must be an integer from 1 through 3");
      }
      const spawned = await supervisor.spawnAdditionalFixture(
        request.stepId,
        request.action,
        count,
      );
      return success(spawned.result, spawned.observations);
    }
    return await base(request);
  };
}

export function createEarlyProductionCaseDrivers(
  supervisor: CaseStackSupervisor,
): ParentStepDrivers {
  const base = createProductionCaseDrivers(supervisor);
  return {
    ...base,
    parent_harness: earlyHarnessDriver(supervisor, base.parent_harness),
  };
}
