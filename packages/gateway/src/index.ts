export const gatewayScaffold = Object.freeze({
  serviceName: "revAgent Gateway",
  milestone: "M0",
  protocol: "RBP/1",
  transportImplemented: false,
  transportSpikeAvailable: true,
  m2FirstSliceAvailable: true,
} as const);

export type GatewayScaffold = typeof gatewayScaffold;

export {
  GatewayDispatcher,
  type GatewayDispatchOutcome,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
  type GatewayInvocationContext,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
export {
  startNorthMcpEndpoint,
  type AuthenticatedNorthMcpRequest,
  type NorthMcpAuthenticator,
  type NorthMcpEndpointHandle,
  type NorthMcpEndpointOptions,
} from "./northMcpEndpoint.js";
export {
  GATEWAY_EXECUTOR_BINDINGS,
  GatewayToolRegistry,
  M2_BOOTSTRAP_TOOL_RECORDS,
  type CapabilityIndex,
  type CapabilityIndexTool,
  type GatewayExecutorBinding,
  type GatewayPolicyClass,
  type GatewayToolRecord,
} from "./registry.js";
export { measureToolCatalog } from "./toolListProbe.js";
export { startTransportSpike } from "./transportSpike.js";
export type {
  ToolCatalogMeasurement,
  ToolCatalogTimingSummary,
} from "./toolListProbe.js";
export type {
  TransportSpikeHandle,
  TransportSpikeOptions,
} from "./transportSpike.js";
