import type { GatewayEventEnvelope } from "./events.js";

export type MetricParityStatus = "derivable" | "missing_fields" | "dying";

export interface MetricParityDevice {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly machineName: string;
  readonly userId: string | null;
  readonly bridgeVersion: string | null;
  readonly lastSeenAtMs: number | null;
}

export interface MetricParitySource {
  readonly tenantId: string;
  readonly events: readonly GatewayEventEnvelope[];
  readonly devices: readonly MetricParityDevice[];
  readonly currentReleaseByChannel: Readonly<Record<string, string | undefined>>;
}

export interface MetricParityRow {
  readonly metric: string;
  readonly status: MetricParityStatus;
  readonly requiredFields: readonly string[];
  readonly reason: string;
}

export interface MetricParityReport {
  readonly tenantId: string;
  readonly rows: readonly MetricParityRow[];
  readonly survivingDerivable: boolean;
  readonly dyingClassified: boolean;
}

interface SurvivingMetricDefinition {
  readonly metric: string;
  readonly requiredFields: readonly string[];
  readonly derive: (source: MetricParitySource) => boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasFields(value: unknown, fields: readonly string[]): boolean {
  const object = asObject(value);
  return object !== null && fields.every((field) => object[field] !== undefined && object[field] !== null);
}

function eventsOf(source: MetricParitySource, type: GatewayEventEnvelope["event_type"]): readonly GatewayEventEnvelope[] {
  return source.events.filter((event) => event.tenant_id === source.tenantId && event.event_type === type);
}

function toolEvents(source: MetricParitySource): readonly GatewayEventEnvelope[] {
  return eventsOf(source, "tool.invocation");
}

export const SURVIVING_METRIC_DEFINITIONS: readonly SurvivingMetricDefinition[] = Object.freeze([
  {
    metric: "machineCount/perMachineIdentity",
    requiredFields: ["devices.device_id", "devices.machine_name", "devices.user_id", "devices.bridge_version"],
    derive: (source) => source.devices.every((device) => device.tenantId === source.tenantId && device.deviceId !== "" && device.machineName !== ""),
  },
  {
    metric: "connectionState/heartbeatAgeSeconds",
    requiredFields: ["devices.last_seen_at", "bridge.connected", "bridge.disconnected"],
    derive: (source) => source.devices.every((device) => device.lastSeenAtMs !== null) &&
      eventsOf(source, "bridge.connected").every((event) => hasFields(event.payload, ["device_id"])) &&
      eventsOf(source, "bridge.disconnected").every((event) => hasFields(event.payload, ["device_id", "reason", "connected_ms"])),
  },
  {
    metric: "versionCurrent/upToDate/outdated",
    requiredFields: ["devices.bridge_version", "release_channels.current_release_id"],
    derive: (source) => source.devices.every((device) => device.bridgeVersion !== null) &&
      Object.values(source.currentReleaseByChannel).some((release) => typeof release === "string" && release.length > 0),
  },
  {
    metric: "taskState/activeTask",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms", "tool_invocations.request_bytes", "tool_invocations.response_bytes"],
    derive: (source) => toolEvents(source).every((event) => hasFields(event.payload, ["outcome", "duration_ms", "request_bytes", "response_bytes"])),
  },
  {
    metric: "bridgeUpdateBadges",
    requiredFields: ["bridge.update.status", "bridge.update.reason"],
    derive: (source) => eventsOf(source, "bridge.update").every((event) => hasFields(event.payload, ["device_id", "status", "reason"])),
  },
  {
    metric: "allStatusActivity",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms", "tool_invocations.request_bytes", "tool_invocations.response_bytes"],
    derive: (source) => toolEvents(source).every((event) => hasFields(event.payload, ["outcome", "duration_ms", "request_bytes", "response_bytes"])),
  },
  {
    metric: "event/session/byMachine/byUserTotals",
    requiredFields: ["events.tenant_id", "events.session_id", "events.actor"],
    derive: (source) => source.events.filter((event) => event.tenant_id === source.tenantId)
      .every((event) => event.session_id !== undefined && event.actor.type !== "system"),
  },
  {
    metric: "productionOperationContext",
    requiredFields: ["tool_invocations.context.project.projectId", "context.elements.disciplineHint", "context.location.levelName", "context.elements.categories", "context.search"],
    derive: (source) => toolEvents(source).every((event) => {
      const context = asObject(event.payload.context);
      return context !== null && hasFields(context.project, ["projectId"]) &&
        hasFields(context.elements, ["disciplineHint", "categories"]) &&
        hasFields(context.location, ["levelName"]) &&
        hasFields(context.search, ["query", "riskLevel", "scannedElementCount", "partial", "scanStoppedReason", "needsScope"]);
    }),
  },
  {
    metric: "frictionGuardedFailedSlow",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms"],
    derive: (source) => toolEvents(source).every((event) => hasFields(event.payload, ["outcome", "duration_ms"])),
  },
  {
    metric: "sendCodeClassification",
    requiredFields: ["tool_invocations.code.hash", "code.length", "code.line_count", "code.write_patterns", "code.has_manual_transaction", "code.preview"],
    derive: (source) => toolEvents(source).filter((event) => {
      const toolName = event.payload.tool_name;
      return toolName === "core.code.execute" || toolName === "core.code.preview";
    }).every((event) => hasFields(event.payload.code, ["hash", "length", "line_count", "write_patterns", "has_manual_transaction", "preview"])),
  },
  {
    metric: "toolUsage/commandUsage",
    requiredFields: ["tool_invocations.tool_name", "tool_invocations.duration_ms", "tool_invocations.outcome"],
    derive: (source) => toolEvents(source).every((event) => hasFields(event.payload, ["tool_name", "duration_ms", "outcome"])),
  },
  {
    metric: "promotion/reconciliation/annotationCandidates",
    requiredFields: ["tool_invocations.code", "tool_invocations.search", "tool_invocations.outcome"],
    derive: (source) => toolEvents(source).every((event) => hasFields(event.payload, ["outcome", "search"]) &&
      (event.payload.code === undefined || asObject(event.payload.code) !== null)),
  },
  {
    metric: "tokenSpend/latency/costAttribution",
    requiredFields: ["llm_calls.input_tokens", "llm_calls.output_tokens", "llm_calls.cache_read_tokens", "llm_calls.duration_ms", "llm_calls.cost"],
    derive: (source) => eventsOf(source, "llm.call").every((event) => hasFields(event.payload, ["input_tokens", "output_tokens", "cache_read_tokens", "duration_ms", "cost"])),
  },
]);

export const DYING_METRIC_CLASSIFICATIONS: readonly Readonly<{ readonly metric: string; readonly reason: string }>[] = Object.freeze([
  { metric: "nasWriteQueueHealth", reason: "NAS event queue is retired; Gateway ingestion health is an operations metric." },
  { metric: "filePipelineAccounting", reason: "Event-file, bad-line, and machine-report counts belong to the retired file pipeline." },
  { metric: "nasUpdaterRunReports", reason: "NAS updater report artifacts retire with NAS; bridge.update is the successor evidence." },
  { metric: "liveStatusFileCacheMerge", reason: "The Gateway connection registry replaces file-cache merge semantics." },
  { metric: "connectionTargetHostPort", reason: "Workstation connection-target fields do not survive Gateway session routing." },
  { metric: "llmSuppliedTaskMetadata", reason: "External client metadata is replaced by Gateway session/turn/invocation identifiers." },
  { metric: "codexSessionExportCorrelation", reason: "Gateway-native session identifiers make the old correlation export obsolete." },
  { metric: "summaryPublisherArtifacts", reason: "Publisher locks, latest files, and local telemetry spools are retired operational artifacts." },
]);

export function deriveMetricParity(source: MetricParitySource): MetricParityReport {
  const sourceEvents = source.events.filter((event) => event.tenant_id === source.tenantId);
  const rows: MetricParityRow[] = SURVIVING_METRIC_DEFINITIONS.map((definition) => {
    const derivable = definition.derive(Object.freeze({ ...source, events: sourceEvents }));
    return Object.freeze({
      metric: definition.metric,
      status: derivable ? "derivable" as const : "missing_fields" as const,
      requiredFields: definition.requiredFields,
      reason: derivable ? "mechanically derivable from the EU-12 data contract" : "required event or catalog fields are absent",
    });
  });
  for (const classification of DYING_METRIC_CLASSIFICATIONS) {
    rows.push(Object.freeze({
      metric: classification.metric,
      status: "dying" as const,
      requiredFields: Object.freeze([]),
      reason: classification.reason,
    }));
  }
  return Object.freeze({
    tenantId: source.tenantId,
    rows: Object.freeze(rows),
    survivingDerivable: rows.filter((row) => row.status !== "dying").every((row) => row.status === "derivable"),
    dyingClassified: rows.filter((row) => row.status === "dying").length === DYING_METRIC_CLASSIFICATIONS.length,
  });
}
