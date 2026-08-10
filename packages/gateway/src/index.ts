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
  invocationAuthorityAvailable: true,
  modeADiscoveryAvailable: true,
  serviceShellAvailable: true,
} as const);

export type GatewayScaffold = typeof gatewayScaffold;

export {
  GatewayDispatcher,
  type GatewayDispatcherOptions,
  type GatewayDispatchOutcome,
  type GatewayDispatchRequest,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
  type GatewayInvocationContext,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
export {
  GATEWAY_CONFIRM_TOKEN_FIELD,
  GATEWAY_PREVIEW_INVOCATION_FIELD,
  GatewayConfirmationControlError,
  buildConfirmationCommitProjection,
  buildConfirmationPreviewProjection,
  gatewayExternalToolInputJsonSchema,
  gatewayExternalToolInputSchema,
  splitGatewayConfirmationArguments,
  type GatewayConfirmationCommitProjection,
  type GatewayConfirmationControl,
  type GatewayConfirmationPreviewProjection,
} from "./confirmation.js";
export {
  GATEWAY_CONFIRMATION_CONTRACT_VERSION,
  GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION,
  GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
  GATEWAY_CONFIRMATION_NAMESPACE,
  GATEWAY_CONFIRMATION_TTL_MS,
  GatewayConfirmationAuthority,
  confirmationIdFromToken,
  confirmationSessionIdFor,
  type GatewayConfirmationAuthorityOptions,
  type GatewayConfirmationApprovalAuditRecord,
  type GatewayConfirmationProof,
  type GatewayConfirmationRefusalReason,
  type GatewayConfirmationStoreFailure,
  type GatewayConfirmationTransactionAuthority,
  type GatewayConfirmationValidationResult,
  type GatewayPendingActionBinding,
  type GatewayPendingActionIssueInput,
  type GatewayPendingActionIssueResult,
  type GatewayPendingActionRecord,
} from "./confirmationAuthority.js";
export {
  GatewayInvocationContextError,
  canonicalParamsDigest,
  createGatewayInvocationContext,
  deriveGatewayInvocationAuthority,
  currentGatewayInvocationContext,
  runWithGatewayInvocationContext,
  type GatewayDocumentIdentity,
  type GatewayInvocationContextErrorCode,
  type GatewayInvocationAuthority,
  type GatewayInvocationRoute,
  type GatewayMutationScope,
  type GatewayParamsDigest,
} from "./invocationContext.js";
export {
  NORTH_MODE_A_META_TOOLS,
  NORTH_MODE_A_PINNED_TOOLS,
  createNorthMcpHttpHandler,
  startNorthMcpEndpoint,
  type AuthenticatedNorthMcpRequest,
  type NorthMcpHostHeaderPolicy,
  type NorthMcpHttpHandler,
  type NorthMcpAuthenticator,
  type NorthMcpEndpointHandle,
  type NorthMcpEndpointOptions,
} from "./northMcpEndpoint.js";
export {
  GATEWAY_SERVER_AUTHORED_INPUT_FIELDS,
  ExecutableRegistryError,
  buildGatewayExecutableRegistry,
  projectGatewayInputJsonSchema,
} from "./executableRegistry.js";

export {
  M2_NORTH_FIRST_SLICE_CALLABLE,
  NorthFirstSliceCompositionError,
  buildNorthFirstSliceCallableRegistry,
} from "./northFirstSlice.js";
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
  type GatewayMutationScopePolicy,
  type GatewayToolRecord,
} from "./registry.js";

// GW-2 service shell. `main.js`, `imageBootSmoke.js` and `testAdapters.js` are
// deliberately absent: the barrel is imported at image build time and must stay
// side-effect free, and withholding the fixture adapters from the package's only
// export path is half of the guarantee that a fake never reaches production.
export {
  GATEWAY_FIXTURE_ADAPTER_KINDS,
  isFixtureAdapterKind,
  isGatewayPortRefusal,
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortErrorCode,
  type GatewayPortName,
  type GatewayPortRefusal,
  type GatewayPortResult,
} from "./gatewayPorts.js";
export {
  GATEWAY_CONFIG_ENV_ALLOWLIST,
  GATEWAY_CONFIG_PROBLEM_MESSAGES,
  GATEWAY_STARTUP_LOG_FIELD_ALLOWLIST,
  loadGatewayConfig,
  startupLogFields,
  type GatewayConfig,
  type GatewayConfigEnvName,
  type GatewayConfigLoadResult,
  type GatewayConfigProblem,
  type GatewayConfigProblemReason,
  type GatewayLogLevel,
  type GatewayNodeEnv,
} from "./config.js";
export {
  GATEWAY_AUTH_CONTRACT_VERSION,
  createUnavailableEntitlementPort,
  createUnavailableIdentityPort,
  type AuthContext,
  type DeviceAuthContext,
  type EntitlementPort,
  type GatewayClientType,
  type GatewayModuleName,
  type GatewayRole,
  type IdentityPort,
} from "./authContext.js";
export {
  REVAGENT_EVENT_SCHEMA,
  createUnavailableEventSink,
  type GatewayEventEnvelope,
  type GatewayEventSink,
  type GatewayEventType,
} from "./events.js";
export {
  GATEWAY_STORE_CONTRACT_VERSION,
  createUnavailableObjectStore,
  createUnavailableProtocolStore,
  type GatewayProtocolStore,
  type ObjectStorePort,
  type StoreErrorCode,
  type StoreExpectation,
  type StoreOutcome,
  type StoreTransaction,
  type StoredRecord,
} from "./store.js";
export {
  GATEWAY_RECOVERY_CONTRACT_VERSION,
  GATEWAY_RECOVERY_NAMESPACE,
  GatewayRecoveryAuthority,
  type GatewayAuditedRecoveryDecisionPort,
  type GatewayBridgeCumulativeAckReceipt,
  type GatewayBridgeEvidenceLookup,
  type GatewayBridgeResumeAuthorization,
  type GatewayDurableBridgeEvidencePort,
  type GatewayDurableBatchTerminal,
  type GatewayDurableDispatchObservation,
  type GatewayExpectedDispatchBinding,
  type GatewayExpectedDispatchTarget,
  type GatewayExpectedInvocationBinding,
  type GatewayExpectedMutationDispatch,
  type GatewayExpectedVerificationDispatch,
  type GatewayVerifiedBridgeJournalEvidence,
  type GatewayRecoveryAuthorityOptions,
  type GatewayRecoveryDispatchHistory,
  type GatewayRecoveryEvidenceResult,
  type GatewayRecoveryEvidenceCandidate,
  type GatewayRecoveryEvidenceDecision,
  type GatewayRecoveryEvidenceDecisionAudit,
  type GatewayRecoveryInvocationWindow,
  type GatewayRecoveryJournalAttestation,
  type GatewayRecoveryMutationEntry,
  type GatewayRecoveryPendingDispatch,
  type GatewayRecoveryPlanResult,
  type GatewayRecoveryPreflightResult,
  type GatewayRecoveryPrepareResult,
  type GatewayRecoveryProtocolFault,
  type GatewayRecoveryRecord,
  type GatewayRecoveryReconcileResult,
  type GatewayRecoveryResolutionPlan,
  type GatewayRecoveryResolutionPlanItem,
  type GatewayRecoveryResumeResult,
  type GatewayRecoveryStoreFailure,
  type GatewayRecoveryWindowAcquireResult,
  type GatewayRecoveryWindowReleaseResult,
} from "./recoveryAuthority.js";
export {
  createUnavailableGuardrailPort,
  type GuardrailDecision,
  type GuardrailPort,
  type GuardrailRefusalCode,
} from "./guardrails.js";
export {
  RBP_INGRESS_HTTP_FALLBACK_PATHS,
  RBP_INGRESS_MOUNT_PREFIX,
  createUnavailableRbpIngressHost,
  type RbpIngressHost,
} from "./rbpIngress.js";
export {
  CodeExecMode,
  ModeBNotImplementedError,
  codeExecSandboxHost,
  generateToolWrapperTree,
  type EngineMode,
  type EngineModeKind,
  type ModelCapabilities,
  type SandboxHost,
} from "./modeB.js";
export {
  GatewayFixturePortError,
  assertProductionPorts,
  buildFastifyOptions,
  createFailClosedPorts,
  createGatewayApp,
  startGatewayServer,
  type GatewayServerHandle,
  type GatewayServerPorts,
} from "./server.js";
// GW-3 executor and policy seed.
export {
  DYNAMIC_CODE_TOOL,
  E5_CONFIRM_CLASS_TOOLS,
  E5_EXPECTED_TOTALS,
  E5_DOCUMENT_RECOVERY_TOOLS,
  E5_NO_RECOVERY_TOOLS,
  E5_SESSION_RECOVERY_TOOLS,
  E5_TOOL_BINDINGS,
  ToolBindingError,
  verifyToolBindings,
  mutationScopePolicyForTool,
  type ToolBindingRow,
} from "./toolBindings.js";
export {
  CatalogError,
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
  type CatalogEntry,
  type EntitlementDecision,
} from "./entitledRegistry.js";
