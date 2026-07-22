import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import envelopeSchema from "../schemas/rbp/v1/envelope.schema.json" with { type: "json" };
import type { RbpEnvelope } from "./generated/envelope.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);

const validate = ajv.compile<RbpEnvelope>(envelopeSchema);

export function validateRbpEnvelope(value: unknown): value is RbpEnvelope {
  return validate(value);
}

export function rbpEnvelopeErrors(): ErrorObject[] {
  return validate.errors ?? [];
}
