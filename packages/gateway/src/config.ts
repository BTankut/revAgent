/**
 * 12-factor, non-secret configuration for the Phase-1 Gateway (GW-2).
 *
 * The acceptance criterion is that startup and `.env.example` contain no LLM,
 * provider or model key or setting. That is enforced by an **allowlist**, not a
 * denylist: this module reads exactly the eight names below by explicit lookup
 * and never enumerates `process.env`. An ambient `OPENAI_API_KEY`,
 * `ANTHROPIC_API_KEY` or `MODEL_NAME` is therefore structurally unreachable
 * rather than merely unused — and no contributor whose machine carries such
 * variables (this project is developed alongside AI tooling) can be refused
 * boot by a denylist false positive.
 *
 * `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are deliberately
 * absent. `deploy/phase1/docker-compose.yml` still injects them for WP4's
 * benefit; the Phase-1 process never reads them, which is what makes "no real
 * OIDC is implemented here" true in code rather than in prose.
 */

export const GATEWAY_CONFIG_ENV_ALLOWLIST = Object.freeze([
  "NODE_ENV",
  "LOG_LEVEL",
  "GATEWAY_BIND_HOST",
  "PORT",
  "GATEWAY_PUBLIC_URL",
  "OBJECT_STORE_DRIVER",
  "OBJECT_STORE_ROOT",
  "DATABASE_URL",
] as const);

export type GatewayConfigEnvName = (typeof GATEWAY_CONFIG_ENV_ALLOWLIST)[number];

export type GatewayNodeEnv =
  | "development"
  | "preproduction"
  | "production"
  | "test";

export type GatewayLogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";

const LOG_LEVELS: readonly GatewayLogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

export type GatewayConfigProblemReason =
  | "missing_required"
  | "not_an_integer"
  | "out_of_range"
  | "unsupported_value"
  | "malformed_url"
  | "insecure_scheme"
  | "loopback_bind_in_production"
  | "invalid_preproduction_bind";

/**
 * Frozen and value-free.
 *
 * No environment value is ever interpolated into a problem message, so the
 * stderr line printed when configuration is rejected cannot echo a Postgres
 * password back into a CI log.
 */
export const GATEWAY_CONFIG_PROBLEM_MESSAGES: Readonly<
  Record<GatewayConfigProblemReason, string>
> = Object.freeze({
  missing_required: "is required but was not set",
  not_an_integer: "must be an integer",
  out_of_range: "is outside the accepted range",
  unsupported_value: "is not one of the accepted values",
  malformed_url: "is not a well-formed URL",
  insecure_scheme: "must use a secure scheme",
  loopback_bind_in_production:
    "must not bind to loopback in production; the container would answer its own health check while refusing external traffic",
  invalid_preproduction_bind:
    "must be exactly 0.0.0.0 inside the pre-production container",
});

export interface GatewayConfigProblem {
  readonly variable: GatewayConfigEnvName;
  readonly reason: GatewayConfigProblemReason;
  readonly message: string;
}

export interface GatewayConfig {
  readonly nodeEnv: GatewayNodeEnv;
  readonly logLevel: GatewayLogLevel;
  readonly http: { readonly bindHost: string; readonly port: number };
  /** Serialized rather than a `URL`, so the startup log line stays plain JSON. */
  readonly publicUrl: string;
  readonly objectStore: { readonly driver: "fs"; readonly root: string | null };
  /** Presence only. The connection string itself is validated and discarded. */
  readonly credentialsPresent: { readonly databaseUrl: boolean };
  readonly ingress: {
    readonly northMcpMountPath: "/mcp";
    readonly rbpMountPrefix: "/bridge/v1";
  };
}

export type GatewayConfigLoadResult =
  | { readonly ok: true; readonly value: GatewayConfig }
  | {
      readonly ok: false;
      readonly code: "invalid_configuration";
      readonly problems: readonly GatewayConfigProblem[];
    };

function problem(
  variable: GatewayConfigEnvName,
  reason: GatewayConfigProblemReason,
): GatewayConfigProblem {
  return Object.freeze({
    variable,
    reason,
    message: `${variable} ${GATEWAY_CONFIG_PROBLEM_MESSAGES[reason]}`,
  });
}

function readValue(
  env: NodeJS.ProcessEnv,
  name: GatewayConfigEnvName,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/**
 * Parses the allowlisted environment into a config, or reports every problem.
 *
 * Never throws and never substitutes a default for a value it rejected: a
 * rejected value that silently becomes a default is how a misconfigured deploy
 * boots green and fails in production.
 */
export function loadGatewayConfig(
  env: NodeJS.ProcessEnv,
): GatewayConfigLoadResult {
  const problems: GatewayConfigProblem[] = [];

  const rawNodeEnv = readValue(env, "NODE_ENV") ?? "development";
  let nodeEnv: GatewayNodeEnv = "development";
  if (
    rawNodeEnv === "development" ||
    rawNodeEnv === "preproduction" ||
    rawNodeEnv === "production" ||
    rawNodeEnv === "test"
  ) {
    nodeEnv = rawNodeEnv;
  } else {
    problems.push(problem("NODE_ENV", "unsupported_value"));
  }

  const rawLogLevel = readValue(env, "LOG_LEVEL") ?? "info";
  let logLevel: GatewayLogLevel = "info";
  if ((LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
    logLevel = rawLogLevel as GatewayLogLevel;
  } else {
    problems.push(problem("LOG_LEVEL", "unsupported_value"));
  }

  // Defaults to every interface, not loopback. A loopback default is the
  // failure this rejects below: the container passes its own health check while
  // the reverse proxy in front of it gets connection refused.
  const rawBindHost = readValue(env, "GATEWAY_BIND_HOST");
  const bindHost = rawBindHost ?? "0.0.0.0";
  if (nodeEnv === "preproduction" && rawBindHost === undefined) {
    problems.push(problem("GATEWAY_BIND_HOST", "missing_required"));
  }
  if (nodeEnv === "production" && LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    problems.push(problem("GATEWAY_BIND_HOST", "loopback_bind_in_production"));
  }
  if (
    nodeEnv === "preproduction" &&
    rawBindHost !== undefined &&
    bindHost !== "0.0.0.0"
  ) {
    problems.push(problem("GATEWAY_BIND_HOST", "invalid_preproduction_bind"));
  }

  let port = 8080;
  const rawPort = readValue(env, "PORT");
  if (rawPort !== undefined) {
    if (!/^\d+$/u.test(rawPort)) {
      problems.push(problem("PORT", "not_an_integer"));
    } else {
      const parsed = Number.parseInt(rawPort, 10);
      if (parsed < 1 || parsed > 65535) {
        problems.push(problem("PORT", "out_of_range"));
      } else {
        port = parsed;
      }
    }
  }

  let publicUrl = `http://127.0.0.1:${String(port)}`;
  const rawPublicUrl = readValue(env, "GATEWAY_PUBLIC_URL");
  if (rawPublicUrl === undefined) {
    if (nodeEnv === "production" || nodeEnv === "preproduction") {
      problems.push(problem("GATEWAY_PUBLIC_URL", "missing_required"));
    }
  } else {
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(rawPublicUrl);
    } catch {
      problems.push(problem("GATEWAY_PUBLIC_URL", "malformed_url"));
    }
    if (parsedUrl !== null) {
      if (
        (nodeEnv === "production" || nodeEnv === "preproduction") &&
        parsedUrl.protocol !== "https:"
      ) {
        problems.push(problem("GATEWAY_PUBLIC_URL", "insecure_scheme"));
      } else {
        publicUrl = parsedUrl.toString();
      }
    }
  }

  const rawDriver = readValue(env, "OBJECT_STORE_DRIVER");
  if (rawDriver !== undefined && rawDriver !== "fs") {
    problems.push(problem("OBJECT_STORE_DRIVER", "unsupported_value"));
  }
  const objectStoreRoot = readValue(env, "OBJECT_STORE_ROOT") ?? null;

  // Validated, then reduced to a boolean. Phase 1 opens no connection; what the
  // shell needs to know is whether WP4 has been given one, and retaining the
  // string past this point would put a password inside the config object that
  // the startup log serializes.
  let databaseUrlPresent = false;
  const rawDatabaseUrl = readValue(env, "DATABASE_URL");
  if (rawDatabaseUrl !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawDatabaseUrl);
    } catch {
      problems.push(problem("DATABASE_URL", "malformed_url"));
    }
    if (parsed !== null) {
      if (
        (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
        parsed.hostname.length === 0
      ) {
        problems.push(problem("DATABASE_URL", "unsupported_value"));
      } else {
        databaseUrlPresent = true;
      }
    }
  }

  if (problems.length > 0) {
    return Object.freeze({
      ok: false as const,
      code: "invalid_configuration" as const,
      problems: Object.freeze(problems),
    });
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      nodeEnv,
      logLevel,
      http: Object.freeze({ bindHost, port }),
      publicUrl,
      objectStore: Object.freeze({ driver: "fs" as const, root: objectStoreRoot }),
      credentialsPresent: Object.freeze({ databaseUrl: databaseUrlPresent }),
      ingress: Object.freeze({
        northMcpMountPath: "/mcp" as const,
        rbpMountPrefix: "/bridge/v1" as const,
      }),
    }),
  });
}

/**
 * The exact field set the startup log line may contain.
 *
 * Enumerated rather than derived so adding a config field cannot silently start
 * logging it, and asserted by a test against this list.
 */
export const GATEWAY_STARTUP_LOG_FIELD_ALLOWLIST = Object.freeze([
  "nodeEnv",
  "logLevel",
  "bindHost",
  "port",
  "publicUrl",
  "objectStoreDriver",
  "objectStoreRoot",
  "databaseUrlPresent",
  "northMcpMountPath",
  "rbpMountPrefix",
] as const);

export function startupLogFields(
  config: GatewayConfig,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.freeze({
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    bindHost: config.http.bindHost,
    port: config.http.port,
    publicUrl: config.publicUrl,
    objectStoreDriver: config.objectStore.driver,
    objectStoreRoot: config.objectStore.root,
    databaseUrlPresent: config.credentialsPresent.databaseUrl,
    northMcpMountPath: config.ingress.northMcpMountPath,
    rbpMountPrefix: config.ingress.rbpMountPrefix,
  });
}
