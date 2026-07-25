import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import aggregateSchema from "../schemas/v1/aggregate-report.schema.json" with { type: "json" };
import buildProvenanceSchema from "../schemas/v1/build-provenance.schema.json" with { type: "json" };
import commonSchema from "../schemas/v1/common.schema.json" with { type: "json" };
import executionPlanSchema from "../schemas/v1/execution-plan.schema.json" with { type: "json" };
import junitSchema from "../schemas/v1/junit-mapping.schema.json" with { type: "json" };
import manifestSchema from "../schemas/v1/manifest.schema.json" with { type: "json" };
import runSchema from "../schemas/v1/run-report.schema.json" with { type: "json" };
import soakSchema from "../schemas/v1/soak-report.schema.json" with { type: "json" };
import caseEvidenceV2Schema from "../schemas/v2/case-evidence.schema.json" with { type: "json" };
import type { ValidationIssue } from "./types.js";

export type SchemaName = "manifest" | "executionPlan" | "run" | "junit" | "aggregate" | "soak" | "caseEvidenceV2" | "buildProvenance";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);

ajv.addSchema(commonSchema);

const validators: Record<SchemaName, ValidateFunction> = {
  manifest: ajv.compile(manifestSchema),
  buildProvenance: ajv.compile(buildProvenanceSchema),
  executionPlan: ajv.compile(executionPlanSchema),
  run: ajv.compile(runSchema),
  junit: ajv.compile(junitSchema),
  aggregate: ajv.compile(aggregateSchema),
  soak: ajv.compile(soakSchema),
  caseEvidenceV2: ajv.compile(caseEvidenceV2Schema),
};

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    code: `schema.${error.keyword}`,
    message: error.message ?? "schema validation failed",
  }));
}

export function validateSchema(name: SchemaName, value: unknown): ValidationIssue[] {
  const validate = validators[name];
  return validate(value) ? [] : toIssues(validate.errors);
}
