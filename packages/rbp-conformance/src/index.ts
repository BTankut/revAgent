export {
  canonicalManifest,
  canonicalManifestIdentity,
  canonicalManifestSha256,
  EXPECTED_CASE_TITLES,
  validateCanonicalManifest,
} from "./manifest.js";
export { createUnexecutedRunReport } from "./scaffold.js";
export { aggregateReportToJUnitXml, createJUnitMapping, renderJUnitXml, runReportToJUnitXml, validateJUnitMapping } from "./junit.js";
export { createThreeRunAggregate, renderAggregateSummary } from "./aggregate.js";
export { classifyRunStatus } from "./runClassification.js";
export { runCli } from "./cli.js";
export {
  assertPassingAggregateReport,
  assertPassingRunReport,
  ConformanceValidationError,
  evaluatePassingAggregate,
  evaluatePassingRun,
  validateAggregateReportStructure,
  validateExecutionPlanStructure,
  validateRunReportStructure,
} from "./validator.js";
export { sha256Json, sha256Text, stableJson } from "./stableJson.js";
export { ASSERTION_CATEGORIES, BINDINGS, COMPONENT_IDS } from "./types.js";
export type {
  ConformanceCaseExecutor,
  HarnessAdapterRegistry,
  HarnessComponentAdapter,
  HarnessStartContext,
  RunningHarnessComponent,
} from "./adapters.js";
export type * from "./types.js";
