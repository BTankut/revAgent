export const gatewayScaffold = Object.freeze({
  serviceName: "revAgent Gateway",
  milestone: "M0",
  protocol: "RBP/1",
  transportImplemented: false,
  transportSpikeAvailable: true,
} as const);

export type GatewayScaffold = typeof gatewayScaffold;

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
