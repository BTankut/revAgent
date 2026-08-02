export const gatewayScaffold = Object.freeze({
  serviceName: "revAgent Gateway",
  milestone: "M2",
  protocol: "RBP/1",
  transportImplemented: false,
  // GW-1 removed the M0 transport spike and the `bundle:legacy` graph it read
  // from: the Gateway must never load the legacy stdio entry point or an M0
  // bundle. The collected registry seed is the only legacy-derived input.
  registrySeedAvailable: true,
  m2FirstSliceAvailable: true,
  modeADiscoveryAvailable: true,
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
  ExecutorPortUnavailableError,
  unboundExecutorPort,
  type ExecutorCallContext,
  type ExecutorPort,
  type ExecutorRequest,
  type ExecutorResult,
} from "./executorPort.js";

export {
  RegistrySeedError,
  verifyRegistrySeed,
  type RegistrySeed,
  type RegistrySeedTool,
} from "./registrySeed.js";

// Verified together or not at all: the seed says which tools exist, the
// manifest says the code behind them is what the packager produced. The
// handler loader that must call both does not exist yet (`transportImplemented`
// is still false), so this is surface, not yet enforcement -- the loader lands
// with it wired, or it lands able to import unverified bytes.
export {
  HandlerManifestError,
  verifyHandlerManifest,
  type HandlerManifest,
  type HandlerManifestModule,
  type VerifyHandlerManifestOptions,
} from "./handlerManifest.js";

export {
  ModeADiscoverySession,
  ModeASchemaBudgetError,
  ModeAToolUnavailableError,
  type ModeAActivationResult,
  type ModeASchemaResult,
  type ModeASearchResult,
} from "./modeADiscovery.js";
export {
  GATEWAY_EXECUTOR_BINDINGS,
  GatewayRegistryView,
  GatewayToolRegistry,
  M2_BOOTSTRAP_TOOL_RECORDS,
  type CapabilityIndex,
  type CapabilityIndexTool,
  type GatewayExecutorBinding,
  type GatewayJsonSchema,
  type GatewayPolicyClass,
  type GatewayToolRecord,
} from "./registry.js";
