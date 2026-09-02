import type { FastifyInstance } from "fastify";

import type {
  M5EnrollmentEntitlementControlPlane,
  M5EnrollmentEntitlementFailureReason,
} from "./m5EnrollmentEntitlement.js";

export const M5_BRIDGE_ENROLLMENT_PATH = "/bridge/v1/enroll" as const;

export const M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES = 8 * 1_024;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const INVALID_BODY = Symbol("invalid_body");

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function duplicateTopLevelKey(raw: string): boolean {
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

function parseBody(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return duplicateTopLevelKey(raw) ? INVALID_BODY : parsed;
  } catch {
    return INVALID_BODY;
  }
}

function exchangeInput(body: unknown): {
  readonly enrollmentCode: string;
  readonly machineFingerprint: string;
} | null {
  if (!plainRecord(body)) return null;
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "enrollment_token" ||
    keys[1] !== "machine_fingerprint"
  ) {
    return null;
  }
  const code = body.enrollment_token;
  const fingerprint = body.machine_fingerprint;
  if (
    typeof code !== "string" ||
    code.length < 32 ||
    code.length > 4_096 ||
    [...code].some((character) => character < "!" || character > "~") ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    return null;
  }
  return Object.freeze({ enrollmentCode: code, machineFingerprint: fingerprint });
}

function refusal(reason: M5EnrollmentEntitlementFailureReason): {
  readonly status: 400 | 401 | 403 | 409 | 503;
  readonly error: string;
} {
  switch (reason) {
    case "enrollment_code_unknown":
    case "enrollment_code_expired":
      return { status: 401, error: "enrollment_token_rejected" };
    case "enrollment_code_reused":
      return { status: 409, error: "enrollment_token_reused" };
    case "enrollment_conflict":
      return { status: 409, error: "enrollment_conflict" };
    case "tenant_binding_denied":
    case "principal_binding_denied":
    case "device_binding_denied":
      return { status: 403, error: "enrollment_denied" };
    case "unavailable":
      return { status: 503, error: "enrollment_exchange_unavailable" };
    default:
      return { status: 400, error: "invalid_enrollment_request" };
  }
}

export interface M5BridgeEnrollmentEndpointOptions {
  /** Shared server drain state; false refuses without consuming the code. */
  readonly isAccepting?: () => boolean;
}

function fixedRefusal(
  reply: { code(status: number): { send(body: unknown): unknown } },
  status: 400 | 413 | 503,
): unknown {
  return reply.code(status).send({
    ok: false,
    state: status === 503 ? "unavailable" : "refused",
    error:
      status === 503
        ? "enrollment_exchange_unavailable"
        : "invalid_enrollment_request",
  });
}

function declaredBodyTooLarge(value: string | undefined): boolean {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES;
}

/** Mounts the exact request/response shape consumed by BridgeEnrollmentExchangeClient. */
export function mountM5BridgeEnrollmentEndpoint(
  app: FastifyInstance,
  controlPlane: Pick<M5EnrollmentEntitlementControlPlane, "exchangeEnrollmentCode">,
  options: M5BridgeEnrollmentEndpointOptions = {},
): void {
  const isAccepting = options.isAccepting ?? (() => true);
  app.register((scope, _options, done) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES },
      (_request, body, parserDone) => {
        const raw = typeof body === "string" ? body : body.toString("utf8");
        parserDone(null, parseBody(raw));
      },
    );
    scope.post(
      M5_BRIDGE_ENROLLMENT_PATH,
      {
        bodyLimit: M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES,
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          if (!isAccepting()) {
            request.raw.resume();
            return fixedRefusal(reply, 503);
          }
          const contentLength = request.headers["content-length"];
          if (
            declaredBodyTooLarge(
              Array.isArray(contentLength) ? contentLength[0] : contentLength,
            )
          ) {
            request.raw.resume();
            return fixedRefusal(reply, 413);
          }
        },
        errorHandler: async (error, _request, reply) =>
          fixedRefusal(
            reply,
            (error as { readonly code?: string }).code ===
              "FST_ERR_CTP_BODY_TOO_LARGE"
              ? 413
              : 400,
          ),
      },
      async (request, reply) => {
        if (!isAccepting()) return fixedRefusal(reply, 503);
        const input = exchangeInput(request.body);
        if (input === null) {
          return fixedRefusal(reply, 400);
        }
        const exchanged = await controlPlane.exchangeEnrollmentCode(input);
        if (!exchanged.ok) {
          const denied = refusal(exchanged.reason);
          return reply.code(denied.status).send({
            ok: false,
            state: denied.status === 503 ? "unavailable" : "refused",
            error: denied.error,
          });
        }
        return reply.code(200).send({
          device_id: exchanged.value.deviceId,
          device_token: exchanged.value.deviceToken,
        });
      },
    );
    done();
  });
}
