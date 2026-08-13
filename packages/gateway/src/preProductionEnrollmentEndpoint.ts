import type { FastifyInstance } from "fastify";

import type { PreProductionIdentityAuthority } from "./preProductionIdentity.js";

export const PRE_PRODUCTION_ENROLLMENT_PATH = "/bridge/v1/enroll" as const;

const MAX_ENROLLMENT_BODY_BYTES = 8 * 1_024;
const MACHINE_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const INVALID_ENROLLMENT_BODY = Symbol("invalid_enrollment_body");

export interface PreProductionEnrollmentEndpoint {
  readonly path: typeof PRE_PRODUCTION_ENROLLMENT_PATH;
  readonly identity: PreProductionIdentityAuthority;
  mount(app: FastifyInstance): void;
}

export interface PreProductionEnrollmentEndpointOptions {
  /** Shared ingress-drain state; false refuses before token consumption. */
  readonly isAccepting?: () => boolean;
}

function unavailable(reply: {
  code(status: number): { send(body: unknown): unknown };
}): unknown {
  return reply.code(503).send({
    ok: false,
    state: "unavailable",
    error: "enrollment_exchange_unavailable",
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * JSON.parse intentionally keeps only the last duplicate object key. Scan the
 * already-valid raw JSON as well so the credential exchange does not inherit
 * that parser ambiguity. Only depth-one keys matter because the accepted body
 * is a flat exact-shape object.
 */
function hasDuplicateTopLevelKey(raw: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  let expectingKey = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      const start = index;
      index += 1;
      for (; index < raw.length; index += 1) {
        if (raw[index] === "\\") {
          index += 1;
          continue;
        }
        if (raw[index] === '"') break;
      }
      if (depth === 1 && expectingKey) {
        let key: unknown;
        try {
          key = JSON.parse(raw.slice(start, index + 1));
        } catch {
          return true;
        }
        if (typeof key !== "string" || keys.has(key)) return true;
        keys.add(key);
        expectingKey = false;
      }
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth === 1 && character === "{") expectingKey = true;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 1) expectingKey = true;
  }
  return false;
}

function parseEnrollmentBody(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID_ENROLLMENT_BODY;
  }
  return hasDuplicateTopLevelKey(raw) ? INVALID_ENROLLMENT_BODY : parsed;
}

function exchangeInput(body: unknown): {
  readonly enrollmentToken: string;
  readonly machineFingerprint: string;
} | null {
  if (!isPlainRecord(body)) {
    return null;
  }
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "enrollment_token" ||
    keys[1] !== "machine_fingerprint"
  ) {
    return null;
  }
  const enrollmentToken = body.enrollment_token;
  const machineFingerprint = body.machine_fingerprint;
  if (
    typeof enrollmentToken !== "string" ||
    enrollmentToken.length < 32 ||
    enrollmentToken.length > 4_096 ||
    [...enrollmentToken].some(
      (character) => character < "!" || character > "~",
    ) ||
    typeof machineFingerprint !== "string" ||
    !MACHINE_FINGERPRINT_PATTERN.test(machineFingerprint)
  ) {
    return null;
  }
  return Object.freeze({ enrollmentToken, machineFingerprint });
}

function refusalFor(reason: string): {
  readonly status: 400 | 401 | 403 | 409;
  readonly error:
    | "invalid_enrollment_request"
    | "enrollment_token_rejected"
    | "enrollment_denied"
    | "enrollment_token_reused"
    | "enrollment_conflict";
} {
  switch (reason) {
    case "enrollment_token_unknown":
    case "enrollment_token_expired":
      return { status: 401, error: "enrollment_token_rejected" };
    case "enrollment_denied":
      return { status: 403, error: "enrollment_denied" };
    case "enrollment_token_reused":
      return { status: 409, error: "enrollment_token_reused" };
    case "enrollment_conflict":
      return { status: 409, error: "enrollment_conflict" };
    default:
      return { status: 400, error: "invalid_enrollment_request" };
  }
}

/**
 * Mounts the Bridge's strict single-use exchange contract.
 *
 * This is deliberately not an enrollment-token minting or admin endpoint.
 * Refusals are fixed and value-free: neither the submitted token nor the
 * authority's diagnostic text reaches an HTTP response.
 */
export function createPreProductionEnrollmentEndpoint(
  identity: PreProductionIdentityAuthority,
  options: PreProductionEnrollmentEndpointOptions = {},
): PreProductionEnrollmentEndpoint {
  const isAccepting = options.isAccepting ?? (() => true);
  return Object.freeze({
    path: PRE_PRODUCTION_ENROLLMENT_PATH,
    identity,
    mount(app: FastifyInstance): void {
      app.register((scope, _options, done) => {
        // Encapsulate the raw parser: north MCP and every other Gateway route
        // retain Fastify's normal JSON parser.
        scope.removeContentTypeParser("application/json");
        scope.addContentTypeParser(
          "application/json",
          { parseAs: "string", bodyLimit: MAX_ENROLLMENT_BODY_BYTES },
          (_request, body, parserDone) => {
            const raw =
              typeof body === "string" ? body : body.toString("utf8");
            parserDone(null, parseEnrollmentBody(raw));
          },
        );
        scope.post(
          PRE_PRODUCTION_ENROLLMENT_PATH,
          {
            bodyLimit: MAX_ENROLLMENT_BODY_BYTES,
            onRequest: async (_request, reply) => {
              reply.header("cache-control", "no-store");
              if (!isAccepting()) return unavailable(reply);
            },
            errorHandler: async (_error, _request, reply) =>
              reply.code(400).send({
                ok: false,
                state: "refused",
                error: "invalid_enrollment_request",
              }),
          },
          async (request, reply) => {
            const input = exchangeInput(request.body);
            if (input === null) {
              return reply.code(400).send({
                ok: false,
                state: "refused",
                error: "invalid_enrollment_request",
              });
            }

            if (!isAccepting()) return unavailable(reply);

            try {
              const exchanged = identity.exchangeEnrollmentToken({
                enrollmentToken: input.enrollmentToken,
                machineFingerprint: input.machineFingerprint,
              });
              if (!exchanged.ok) {
                const refusal = refusalFor(exchanged.reason);
                return reply.code(refusal.status).send({
                  ok: false,
                  state: "refused",
                  error: refusal.error,
                });
              }
              return reply.code(200).send({
                device_id: exchanged.value.deviceId,
                device_token: exchanged.value.deviceToken,
              });
            } catch {
              return unavailable(reply);
            }
          },
        );
        done();
      });
    },
  });
}
