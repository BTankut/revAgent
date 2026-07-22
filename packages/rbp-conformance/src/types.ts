export const COMPONENT_IDS = [
  "gateway_stub",
  "bridge_simulator",
  "addin_loopback_fixture",
] as const;

export const BINDINGS = ["wss", "streamable_http_sse"] as const;

export const ASSERTION_CATEGORIES = [
  "wire_behavior",
  "journal_truth",
  "execution_count",
  "authorization",
  "timing",
  "resource_leak",
  "artifact_integrity",
  "compatibility",
  "schema",
  "recovery",
  "transport_parity",
  "discovery",
  "safety",
] as const;

export type ComponentId = (typeof COMPONENT_IDS)[number];
export type Binding = (typeof BINDINGS)[number];
export type AssertionCategory = (typeof ASSERTION_CATEGORIES)[number];
export type CaseStatus = "not_run" | "running" | "passed" | "failed" | "error" | "skipped";
export type RunStatus = "initialized" | "running" | "passed" | "failed" | "error";
export type AggregateStatus = "passed" | "failed" | "incomplete";

export interface ManifestIdentity {
  id: "rbp-v1.0-freeze-section-21";
  version: "1";
  sha256: string;
  specVersion: "1.0-rc.1";
}

export interface SourceIdentity {
  repository: string;
  commitSha: string;
  treeSha: string;
  dirty: false;
}

export interface ComponentIdentity {
  version: string;
  protocolVersion: "1.0-rc.1";
  commitSha: string;
  treeSha: string;
  executableSha256: string;
}

export interface ProcessCommandDescriptor {
  executable: string;
  args: string[];
  workingDirectory: string;
  environmentKeys: string[];
  readiness: {
    kind: "stdout_pattern" | "tcp_loopback" | "http_loopback" | "process_alive";
    value: string;
    timeoutMs: number;
  };
  shutdown: {
    signal: "SIGINT" | "SIGTERM" | "stdin_eof";
    timeoutMs: number;
  };
}

export interface PlannedComponent {
  id: ComponentId;
  interfaceVersion: string;
  expectedIdentity: ComponentIdentity;
  command: ProcessCommandDescriptor;
}

export interface ExecutionPlan {
  schemaVersion: "rbp-conformance-execution-plan/v1";
  manifest: ManifestIdentity;
  runId: string;
  sequence: 1 | 2 | 3;
  source: SourceIdentity;
  components: PlannedComponent[];
}

export interface ProcessEvidence {
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
}

export interface ComponentEvidence extends PlannedComponent {
  observedIdentity: ComponentIdentity | null;
  process: ProcessEvidence;
}

export type ArtifactKind =
  | "run_report"
  | "junit"
  | "component_log"
  | "wire_trace"
  | "journal_snapshot"
  | "leak_metrics"
  | "aggregate_report"
  | "aggregate_junit"
  | "case_evidence"
  | "soak_report"
  | "soak_metrics";

export interface ArtifactEvidence {
  kind: ArtifactKind;
  path: string;
  sha256: string;
  bytes: number;
  mediaType: string;
}

export interface AssertionResult {
  assertionId: string;
  subvectorId: string;
  statement: string;
  category: AssertionCategory;
  passed: boolean | null;
  expected: unknown;
  actual: unknown;
  observationIds: string[];
  evidenceSha256: string | null;
  message: string | null;
}

export interface BindingResult {
  binding: Binding;
  status: CaseStatus;
  durationMs: number | null;
}

export interface FailureEvidence {
  code: string;
  message: string;
}

export interface CaseResult {
  caseId: string;
  title: string;
  status: CaseStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  requiredComponents: ComponentId[];
  bindings: BindingResult[];
  assertions: AssertionResult[];
  artifacts: ArtifactEvidence[];
  failure: FailureEvidence | null;
}

export interface LeakCounters {
  openFileDescriptorDelta: number;
  residentBytesDelta: number;
  journalPendingDelta: number;
  orphanProcessCount: number;
}

export type ResourceSamplingMode = "bounded_slope" | "post_gc";

export interface ResourceSample {
  index: number;
  offsetMs: number;
  residentBytes: number;
  openFileDescriptorCount: number;
  journalPendingCount: number;
}

export interface ResourcePolicy {
  warmupSamples: 2;
  minimumMeasuredSamples: 6;
  maxResidentGrowthBytes: 67108864;
  maxResidentSlopeBytesPerSecond: 2097152;
  maxOpenFileDescriptorGrowth: 0;
  maxJournalPendingGrowth: 0;
  maxOrphanProcessCount: 0;
}

export interface ResourceEvaluation {
  sampleCount: number;
  measuredSampleCount: number;
  residentGrowthBytes: number;
  residentSlopeBytesPerSecond: number;
  openFileDescriptorGrowth: number;
  journalPendingGrowth: number;
  orphanProcessCount: number;
  passed: boolean;
}

export interface ResourceProfile {
  schemaVersion: "rbp-resource-profile/v1";
  samplingMode: ResourceSamplingMode;
  sampleIntervalMs: number;
  policy: ResourcePolicy;
  gcConfirmedComponents: ComponentId[];
  samples: ResourceSample[];
  evaluation: ResourceEvaluation | null;
}

export interface RunReport {
  schemaVersion: "rbp-conformance-run/v1";
  manifest: ManifestIdentity;
  run: {
    runId: string;
    sequence: 1 | 2 | 3;
    status: RunStatus;
    seed: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    exitCode: number | null;
  };
  source: SourceIdentity;
  components: ComponentEvidence[];
  cases: CaseResult[];
  timing: {
    suiteDurationMs: number | null;
    setupDurationMs: number | null;
    teardownDurationMs: number | null;
  };
  leaks: LeakCounters;
  resources: ResourceProfile;
  artifacts: ArtifactEvidence[];
}

export interface JUnitCaseMapping {
  caseId: string;
  className: "revAgent.rbp.v1.section21";
  testName: string;
  status: CaseStatus;
  durationMs: number;
  failure: FailureEvidence | null;
}

export interface JUnitMapping {
  schemaVersion: "rbp-conformance-junit/v1";
  manifest: ManifestIdentity;
  runId: string;
  suiteName: "RBP/1 section 21 v1.0 freeze";
  tests: 40;
  failures: number;
  errors: number;
  skipped: number;
  durationMs: number;
  cases: JUnitCaseMapping[];
}

export interface AggregateRunReference {
  runId: string;
  sequence: 1 | 2 | 3;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  manifest: ManifestIdentity;
  source: SourceIdentity;
  components: Array<{
    id: ComponentId;
    interfaceVersion: string;
    identity: ComponentIdentity | null;
  }>;
  bindings: Binding[];
  reportPath: string;
  reportSha256: string;
}

export interface EvidenceAssertionRecord {
  assertionId: string;
  subvectorId: string;
  statement: string;
  category: AssertionCategory;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  observationIds: string[];
}

export interface ProcessObservationRecord {
  schemaVersion: "rbp-process-observation/v1";
  observationId: string;
  runId: string;
  caseId: string;
  binding: Binding;
  componentId: ComponentId;
  kind:
    | "control_result"
    | "wire_event"
    | "gateway_snapshot"
    | "bridge_snapshot"
    | "fixture_snapshot"
    | "fixture_execution_count"
    | "resource_sample";
  at: string;
  payload: unknown;
}

export interface CaseEvidenceDocument {
  schemaVersion: "rbp-case-evidence/v1";
  runId: string;
  caseId: string;
  source: "journal_snapshot" | "case_evidence";
  observations: ProcessObservationRecord[];
  assertions: EvidenceAssertionRecord[];
}

export interface WireTraceRecord {
  schemaVersion: "rbp-wire-trace/v1";
  runId: string;
  caseId: string;
  binding: Binding;
  event: string;
  at: string;
  status: CaseStatus;
  assertions: EvidenceAssertionRecord[];
}

export interface ComponentLogRecord {
  schemaVersion: "rbp-component-log/v1";
  runId: string;
  componentId: ComponentId;
  interfaceVersion: string;
  identity: ComponentIdentity;
  process: ProcessEvidence;
}

export interface LeakMetricsDocument {
  schemaVersion: "rbp-conformance-leaks/v1";
  runId: string;
  timing: RunReport["timing"];
  leaks: LeakCounters;
  resources: ResourceProfile;
}

export type SoakMode = "smoke" | "one_hour";
export type SoakStatus = "passed" | "failed" | "error";

export interface SoakCycleRecord {
  cycle: number;
  binding: Binding;
  startedAt: string;
  finishedAt: string;
  reconnects: number;
  proxyChurns: number;
  heartbeatAcks: number;
  controlRoundTrips: number;
  journalPending: number;
  passed: boolean;
}

export interface SoakMetricRecord {
  schemaVersion: "rbp-reconnect-soak-metric/v1";
  runId: string;
  mode: SoakMode;
  cycle: number;
  binding: Binding;
  at: string;
  reconnects: number;
  proxyChurns: number;
  heartbeatAcks: number;
  controlRoundTrips: number;
  journalPending: number;
  resourceSample: ResourceSample;
}

export interface SoakReport {
  schemaVersion: "rbp-reconnect-soak/v1";
  manifest: ManifestIdentity;
  mode: SoakMode;
  runId: string;
  status: SoakStatus;
  source: SourceIdentity;
  components: Array<{
    id: ComponentId;
    interfaceVersion: string;
    identity: ComponentIdentity;
  }>;
  startedAt: string;
  finishedAt: string;
  requestedDurationMs: number;
  actualDurationMs: number;
  cycles: SoakCycleRecord[];
  resources: ResourceProfile;
  artifacts: ArtifactEvidence[];
  failure: FailureEvidence | null;
}

export interface AggregateCaseResult {
  caseId: string;
  title: string;
  runStatuses: CaseStatus[];
  passedAllRuns: boolean;
}

export interface AggregateReport {
  schemaVersion: "rbp-conformance-aggregate/v1";
  manifest: ManifestIdentity;
  reportPath: string;
  generatedAt: string;
  source: SourceIdentity;
  status: AggregateStatus;
  consecutive: boolean;
  runs: AggregateRunReference[];
  summary: {
    requiredRuns: 3;
    passingRuns: number;
    failedRuns: number;
    incompleteRuns: number;
    totalDurationMs: number;
  };
  cases: AggregateCaseResult[];
  artifacts: ArtifactEvidence[];
}

export interface ManifestCase {
  id: string;
  ordinal: number;
  title: string;
  requiredComponents: ComponentId[];
  bindings: Binding[];
  assertionCategories: AssertionCategory[];
}

export interface ManifestAssertion {
  id: string;
  subvectorId: string;
  statement: string;
  category: AssertionCategory;
  expected: true;
}

export interface ConformanceManifest {
  $schema: string;
  schemaVersion: "rbp-conformance-manifest/v1";
  manifestId: "rbp-v1.0-freeze-section-21";
  manifestVersion: "1";
  spec: {
    name: string;
    version: "1.0-rc.1";
    section: "21";
    sourcePath: "docs/specs/O1-bridge-gateway-protocol.md";
  };
  requiredAggregateRuns: 3;
  requiredComponents: Array<{ id: ComponentId; interfaceVersion: string }>;
  retainedEvidence: {
    root: string;
    runReport: string;
    junit: string;
    componentLog: string;
    wireTrace: string;
    journalSnapshot: string;
    caseEvidence: string;
    leakMetrics: string;
    aggregateReport: string;
    aggregateJunit: string;
    soakReport: string;
    soakMetrics: string;
    hashAlgorithm: "sha256";
  };
  cases: ManifestCase[];
  requiredAssertions: Record<string, ManifestAssertion[]>;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export interface PassingValidationOptions {
  expectedCommitSha?: string;
  expectedTreeSha?: string;
  artifactRoot?: string;
  verifyArtifactFiles?: boolean;
  aggregateReportFile?: string;
  soakReportFile?: string;
}

export interface AggregateInput {
  report: RunReport;
  reportPath: string;
  reportSha256: string;
}
