import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface BatchDigestStep {
  invocation_id: string;
  method: string;
  mutating: boolean;
  mutation_scope: JsonValue;
  params_digest: string;
  policy: {
    class: string;
    confirmation_id: string | null;
    decision: string;
  };
}

export interface BatchDigestInput {
  atomic: boolean;
  batch_id: string;
  recovery_clearances: JsonValue[];
  steps: BatchDigestStep[];
  timeout_ms: number;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("RFC 8785 input contains an unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("RFC 8785 input contains an unpaired low surrogate");
    }
  }
}

function quote(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

/**
 * Serializes an already-parsed JSON value using RFC 8785 JCS rules.
 * The wire decoder remains responsible for rejecting duplicate object keys.
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("RFC 8785 input numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      return quote(value);
    case "object": {
      if (Array.isArray(value)) {
        const values: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new TypeError(`RFC 8785 input contains an undefined array item at ${index}`);
          }
          values.push(canonicalizeJson(value[index]));
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("RFC 8785 input must contain only JSON objects");
      }

      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("RFC 8785 input cannot contain symbol-keyed members");
      }

      if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
        throw new TypeError("RFC 8785 input cannot contain non-enumerable members");
      }

      const members = Object.keys(value)
        .sort()
        .map((key) => {
          const member = value[key];
          if (member === undefined) {
            throw new TypeError(`RFC 8785 input contains undefined member ${key}`);
          }
          return `${quote(key)}:${canonicalizeJson(member)}`;
        });
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`RFC 8785 input cannot contain ${typeof value}`);
  }
}

function makeJsonDigest(value: JsonValue): `sha256:${string}` {
  const canonicalParamsBytes = Buffer.from(canonicalizeJson(value), "utf8");
  const digest = createHash("sha256").update(canonicalParamsBytes).digest("hex");
  return `sha256:${digest}`;
}

export function makeParamsDigest(params: JsonValue): `sha256:${string}` {
  return makeJsonDigest(params);
}

/** Computes the exact Section 11 batch_digest material; display/raw params are excluded. */
export function makeBatchDigest(batch: BatchDigestInput): `sha256:${string}` {
  return makeJsonDigest({
    atomic: batch.atomic,
    batch_id: batch.batch_id,
    recovery_clearances: batch.recovery_clearances,
    steps: batch.steps.map((step) => ({
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope,
      params_digest: step.params_digest,
      policy: {
        class: step.policy.class,
        confirmation_id: step.policy.confirmation_id,
        decision: step.policy.decision,
      },
    })),
    timeout_ms: batch.timeout_ms,
  });
}
