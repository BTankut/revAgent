import type { GatewayJsonValue } from "./dispatch.js";
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
  readonly observedCount: number;
  readonly requiredMinimum: number;
  readonly value: GatewayJsonValue | null;
  readonly reason: string;
}

export interface MetricParityReport {
  readonly tenantId: string;
  readonly rows: readonly MetricParityRow[];
  readonly survivingDerivable: boolean;
  readonly dyingClassified: boolean;
}

interface MetricEvidence {
  readonly observedCount: number;
  readonly requiredMinimum: number;
  readonly value: GatewayJsonValue | null;
  readonly valid: boolean;
}

interface SurvivingMetricDefinition {
  readonly metric: string;
  readonly requiredFields: readonly string[];
  readonly derive: (source: MetricParitySource) => MetricEvidence;
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

function asMetricValue(value: unknown): GatewayJsonValue {
  return value as GatewayJsonValue;
}

function tenantEvents(source: MetricParitySource): readonly GatewayEventEnvelope[] {
  return source.events.filter((event) => event.tenant_id === source.tenantId);
}

function eventsOf(source: MetricParitySource, type: GatewayEventEnvelope["event_type"]): readonly GatewayEventEnvelope[] {
  return tenantEvents(source).filter((event) => event.event_type === type);
}

function toolEvents(source: MetricParitySource): readonly GatewayEventEnvelope[] {
  return eventsOf(source, "tool.invocation");
}

function countBy(events: readonly GatewayEventEnvelope[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const raw = event.payload[field];
    const key = typeof raw === "string" ? raw : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function eventEvidence(
  events: readonly GatewayEventEnvelope[],
  required: readonly string[],
  project: (rows: readonly GatewayEventEnvelope[]) => GatewayJsonValue,
): MetricEvidence {
  const valid = events.length > 0 && events.every((event) => hasFields(event.payload, required));
  return Object.freeze({
    observedCount: events.length,
    requiredMinimum: 1,
    value: valid ? project(events) : null,
    valid,
  });
}

function validProductionContext(event: GatewayEventEnvelope): boolean {
  const context = asObject(event.payload.context);
  return context !== null &&
    hasFields(context.project, ["projectId"]) &&
    hasFields(context.elements, ["disciplineHint", "categories"]) &&
    hasFields(context.location, ["levelName"]) &&
    hasFields(context.search, ["query", "riskLevel", "scannedElementCount", "partial", "scanStoppedReason", "needsScope"]);
}

function productionContextValue(events: readonly GatewayEventEnvelope[]): GatewayJsonValue {
  const disciplineCounts: Record<string, number> = {};
  const projectIds: string[] = [];
  for (const event of events) {
    const context = asObject(event.payload.context)!;
    const project = asObject(context.project)!;
    const elements = asObject(context.elements)!;
    if (typeof project.projectId === "string") projectIds.push(project.projectId);
    const discipline = typeof elements.disciplineHint === "string" ? elements.disciplineHint : "unknown";
    disciplineCounts[discipline] = (disciplineCounts[discipline] ?? 0) + 1;
  }
  return asMetricValue({ projectIds: [...new Set(projectIds)].sort(), disciplineCounts });
}

function codeRows(events: readonly GatewayEventEnvelope[]): readonly Record<string, unknown>[] {
  return events.flatMap((event) => {
    const code = asObject(event.payload.code);
    return code === null ? [] : [code];
  });
}

/**
 * O11 parity is evidence-based: every survivor needs at least one complete
 * record, rather than receiving a vacuous green result from an empty array.
 */
export const SURVIVING_METRIC_DEFINITIONS: readonly SurvivingMetricDefinition[] = Object.freeze([
  {
    metric: "machineCount/perMachineIdentity",
    requiredFields: ["devices.device_id", "devices.machine_name", "devices.user_id", "devices.bridge_version"],
    derive: (source) => {
      const devices = source.devices.filter((device) => device.tenantId === source.tenantId);
      const valid = devices.length > 0 && devices.every((device) => device.deviceId !== "" && device.machineName !== "" && device.userId !== null && device.bridgeVersion !== null);
      return Object.freeze({
        observedCount: devices.length,
        requiredMinimum: 1,
        value: valid ? asMetricValue({ machineCount: devices.length, machines: devices.map((device) => ({ deviceId: device.deviceId, machineName: device.machineName, userId: device.userId, bridgeVersion: device.bridgeVersion })) }) : null,
        valid,
      });
    },
  },
  {
    metric: "connectionState/heartbeatAgeSeconds",
    requiredFields: ["devices.last_seen_at", "bridge.connected", "bridge.disconnected"],
    derive: (source) => {
      const devices = source.devices.filter((device) => device.tenantId === source.tenantId);
      const connected = eventsOf(source, "bridge.connected");
      const disconnected = eventsOf(source, "bridge.disconnected");
      const valid = devices.length > 0 && connected.length > 0 && disconnected.length > 0 && devices.every((device) => device.lastSeenAtMs !== null) && connected.every((event) => hasFields(event.payload, ["device_id"])) && disconnected.every((event) => hasFields(event.payload, ["device_id", "reason", "connected_ms"]));
      return Object.freeze({
        observedCount: devices.length + connected.length + disconnected.length,
        requiredMinimum: 3,
        value: valid ? asMetricValue({ deviceCount: devices.length, connectedTransitions: connected.length, disconnectedTransitions: disconnected.length, lastSeenAtMs: devices.map((device) => ({ deviceId: device.deviceId, value: device.lastSeenAtMs })) }) : null,
        valid,
      });
    },
  },
  {
    metric: "versionCurrent/upToDate/outdated",
    requiredFields: ["devices.bridge_version", "release_channels.current_release_id"],
    derive: (source) => {
      const devices = source.devices.filter((device) => device.tenantId === source.tenantId);
      const releases = Object.entries(source.currentReleaseByChannel).filter(([, value]) => typeof value === "string" && value.length > 0);
      const valid = devices.length > 0 && releases.length > 0 && devices.every((device) => device.bridgeVersion !== null);
      return Object.freeze({ observedCount: devices.length + releases.length, requiredMinimum: 2, value: valid ? asMetricValue({ releases: Object.fromEntries(releases), bridgeVersions: devices.map((device) => ({ deviceId: device.deviceId, bridgeVersion: device.bridgeVersion })) }) : null, valid });
    },
  },
  {
    metric: "taskState/activeTask",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms", "tool_invocations.request_bytes", "tool_invocations.response_bytes"],
    derive: (source) => eventEvidence(toolEvents(source), ["outcome", "duration_ms", "request_bytes", "response_bytes"], (events) => asMetricValue({ activeTaskCount: events.filter((event) => event.payload.outcome === "running").length, invocationCount: events.length })),
  },
  {
    metric: "bridgeUpdateBadges",
    requiredFields: ["bridge.update.status", "bridge.update.reason"],
    derive: (source) => eventEvidence(eventsOf(source, "bridge.update"), ["device_id", "status", "reason"], (events) => asMetricValue({ byStatus: countBy(events, "status") })),
  },
  {
    metric: "allStatusActivity",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms", "tool_invocations.request_bytes", "tool_invocations.response_bytes"],
    derive: (source) => eventEvidence(toolEvents(source), ["outcome", "duration_ms", "request_bytes", "response_bytes"], (events) => asMetricValue({ byOutcome: countBy(events, "outcome"), totalDurationMs: events.reduce((sum, event) => sum + Number(event.payload.duration_ms), 0), totalRequestBytes: events.reduce((sum, event) => sum + Number(event.payload.request_bytes), 0), totalResponseBytes: events.reduce((sum, event) => sum + Number(event.payload.response_bytes), 0) })),
  },
  {
    metric: "event/session/byMachine/byUserTotals",
    requiredFields: ["events.tenant_id", "events.session_id", "events.actor"],
    derive: (source) => {
      const events = tenantEvents(source);
      const valid = events.length > 0 && events.every((event) => event.session_id !== undefined && (event.actor.user_id !== undefined || event.actor.device_id !== undefined));
      return Object.freeze({ observedCount: events.length, requiredMinimum: 1, value: valid ? asMetricValue({ eventCount: events.length, sessionCount: new Set(events.map((event) => event.session_id)).size, actorCount: new Set(events.map((event) => event.actor.user_id ?? event.actor.device_id)).size }) : null, valid });
    },
  },
  {
    metric: "productionOperationContext",
    requiredFields: ["tool_invocations.context.project.projectId", "context.elements.disciplineHint", "context.location.levelName", "context.elements.categories", "context.search"],
    derive: (source) => {
      const events = toolEvents(source);
      const valid = events.length > 0 && events.every(validProductionContext);
      return Object.freeze({ observedCount: events.length, requiredMinimum: 1, value: valid ? productionContextValue(events) : null, valid });
    },
  },
  {
    metric: "frictionGuardedFailedSlow",
    requiredFields: ["tool_invocations.outcome", "tool_invocations.duration_ms"],
    derive: (source) => eventEvidence(toolEvents(source), ["outcome", "duration_ms"], (events) => asMetricValue({ guarded: events.filter((event) => event.payload.outcome === "guarded").length, failed: events.filter((event) => event.payload.outcome === "failed").length, slow: events.filter((event) => Number(event.payload.duration_ms) >= 10_000).length })),
  },
  {
    metric: "sendCodeClassification",
    requiredFields: ["tool_invocations.code.hash", "code.length", "code.lineCount", "code.writePatterns", "code.hasManualTransaction", "code.preview"],
    derive: (source) => {
      const events = toolEvents(source).filter((event) => event.payload.tool_name === "core.code.execute" || event.payload.tool_name === "core.code.preview");
      const codes = codeRows(events);
      const valid = events.length > 0 && codes.length === events.length && codes.every((code) => hasFields(code, ["hash", "length", "lineCount", "writePatterns", "hasManualTransaction", "preview"]));
      const patterns: Record<string, number> = {};
      for (const code of codes) for (const pattern of Array.isArray(code.writePatterns) ? code.writePatterns : []) if (typeof pattern === "string") patterns[pattern] = (patterns[pattern] ?? 0) + 1;
      return Object.freeze({ observedCount: events.length, requiredMinimum: 1, value: valid ? asMetricValue({ count: events.length, safeCount: events.filter((event) => event.payload.tool_name === "core.code.preview").length, rawCount: events.filter((event) => event.payload.tool_name === "core.code.execute").length, manualTransactionCount: codes.filter((code) => code.hasManualTransaction === true).length, writePatternCounts: patterns }) : null, valid });
    },
  },
  {
    metric: "toolUsage/commandUsage",
    requiredFields: ["tool_invocations.tool_name", "tool_invocations.duration_ms", "tool_invocations.outcome"],
    derive: (source) => eventEvidence(toolEvents(source), ["tool_name", "duration_ms", "outcome"], (events) => asMetricValue({ byTool: countBy(events, "tool_name") })),
  },
  {
    metric: "promotion/reconciliation/annotationCandidates",
    requiredFields: ["tool_invocations.code", "tool_invocations.search", "tool_invocations.outcome"],
    derive: (source) => {
      const events = toolEvents(source);
      const codes = codeRows(events);
      const valid = events.length > 0 && codes.length === events.length && events.every((event) => hasFields(event.payload, ["search", "outcome"]));
      const repeats: Record<string, number> = {};
      for (const code of codes) if (typeof code.hash === "string") repeats[code.hash] = (repeats[code.hash] ?? 0) + 1;
      return Object.freeze({ observedCount: events.length, requiredMinimum: 1, value: valid ? asMetricValue({ repeatedHashCandidates: Object.entries(repeats).filter(([, count]) => count >= 2).map(([hash, count]) => ({ hash, count })) }) : null, valid });
    },
  },
  {
    metric: "tokenSpend/latency/costAttribution",
    requiredFields: ["llm_calls.input_tokens", "llm_calls.output_tokens", "llm_calls.cache_read_tokens", "llm_calls.cache_creation_tokens", "llm_calls.latency_ms", "llm_calls.cost_microusd"],
    derive: (source) => eventEvidence(eventsOf(source, "llm.call"), ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "latency_ms", "cost_microusd"], (events) => asMetricValue({ inputTokens: events.reduce((sum, event) => sum + Number(event.payload.input_tokens), 0), outputTokens: events.reduce((sum, event) => sum + Number(event.payload.output_tokens), 0), cacheReadTokens: events.reduce((sum, event) => sum + Number(event.payload.cache_read_tokens), 0), cacheCreationTokens: events.reduce((sum, event) => sum + Number(event.payload.cache_creation_tokens), 0), latencyMs: events.reduce((sum, event) => sum + Number(event.payload.latency_ms), 0), costMicrousd: events.reduce((sum, event) => sum + Number(event.payload.cost_microusd), 0) })),
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
  const rows: MetricParityRow[] = SURVIVING_METRIC_DEFINITIONS.map((definition) => {
    const evidence = definition.derive(source);
    return Object.freeze({
      metric: definition.metric,
      status: evidence.valid ? "derivable" as const : "missing_fields" as const,
      requiredFields: definition.requiredFields,
      observedCount: evidence.observedCount,
      requiredMinimum: evidence.requiredMinimum,
      value: evidence.value,
      reason: evidence.valid ? "mechanically derived from populated EU-12 records" : "no non-empty, field-complete evidence exists for this survivor",
    });
  });
  for (const classification of DYING_METRIC_CLASSIFICATIONS) {
    rows.push(Object.freeze({
      metric: classification.metric,
      status: "dying" as const,
      requiredFields: Object.freeze([]),
      observedCount: 0,
      requiredMinimum: 0,
      value: asMetricValue({ classification: "dying" }),
      reason: classification.reason,
    }));
  }
  return Object.freeze({
    tenantId: source.tenantId,
    rows: Object.freeze(rows),
    survivingDerivable: rows.filter((row) => row.status !== "dying").every((row) => row.status === "derivable" && row.observedCount >= row.requiredMinimum),
    dyingClassified: rows.filter((row) => row.status === "dying").length === DYING_METRIC_CLASSIFICATIONS.length,
  });
}
