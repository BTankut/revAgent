export const gatewayScaffold = Object.freeze({
  serviceName: "revAgent Gateway",
  milestone: "M0",
  protocol: "RBP/1",
  transportImplemented: false,
} as const);

export type GatewayScaffold = typeof gatewayScaffold;
