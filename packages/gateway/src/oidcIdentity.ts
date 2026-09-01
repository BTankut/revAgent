import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { AuthContext, GatewayRole, IdentityPort } from "./authContext.js";
import { GATEWAY_AUTH_CONTRACT_VERSION } from "./authContext.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type { NorthMcpAuthenticator } from "./northMcpEndpoint.js";
import type { OidcPrincipalInput } from "./postgresTenantStore.js";

const UUID_NAMESPACE = "revagent-eu10-session";
const ROLES: readonly GatewayRole[] = ["user", "tenant_admin", "vendor_admin"];

export interface OidcIdentityRepository {
  upsertOidcPrincipal(input: OidcPrincipalInput): Promise<{ readonly userId: string } | null>;
}

export interface OidcIdentityOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly repository: OidcIdentityRepository;
  readonly requiredScopes?: readonly string[];
  readonly keyResolver?: JWTVerifyGetKey;
  readonly now?: () => number;
  /** Value-free diagnostic seam; never receives a token or claim value. */
  readonly reportRefusal?: (reason: "missing_bearer" | "jwt_verification" | "claims_identity" | "claims_time" | "claims_authority" | "tenant_repository") => void;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(UUID_NAMESPACE).update("\0").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function claimString(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function roleFrom(payload: JWTPayload): GatewayRole | null {
  const direct = payload.roles;
  const realm = payload.realm_access;
  const candidates = Array.isArray(direct) ? direct :
    realm !== null && typeof realm === "object" && Array.isArray((realm as { roles?: unknown }).roles)
      ? (realm as { roles: unknown[] }).roles : [];
  for (const role of ["vendor_admin", "tenant_admin", "user"] as const) {
    if (candidates.includes(role)) return role;
  }
  return null;
}

function scopesFrom(payload: JWTPayload): readonly string[] {
  const scope = claimString(payload, "scope");
  return scope === null ? Object.freeze([]) : Object.freeze(scope.split(/\s+/u).filter(Boolean));
}

function bearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

export function createOidcIdentityPort(options: OidcIdentityOptions): IdentityPort & { readonly kind: "oidc" } {
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(new URL(options.jwksUri));
  const now = options.now ?? Date.now;
  return Object.freeze({
    kind: "oidc" as const,
    async authenticateNorthRequest(input: { readonly authorization: string | undefined }): Promise<GatewayPortResult<AuthContext>> {
      const token = bearer(input.authorization);
      if (token === null) { options.reportRefusal?.("missing_bearer"); return refusal(); }
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, keyResolver, {
          issuer: options.issuer,
          audience: options.audience,
          currentDate: new Date(now()),
          algorithms: ["RS256"],
        });
        payload = verified.payload;
      } catch {
        options.reportRefusal?.("jwt_verification");
        return refusal();
      }
      try {
        const tenantId = claimString(payload, "tenant_id");
        const subject = payload.sub ?? null;
        const role = roleFrom(payload);
        const scopes = scopesFrom(payload);
        const requiredScopes = options.requiredScopes ?? ["mcp:read"];
        if (tenantId === null || subject === null || role === null) {
          options.reportRefusal?.("claims_identity"); return refusal();
        }
        if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp <= payload.iat) {
          options.reportRefusal?.("claims_time"); return refusal();
        }
        if (!ROLES.includes(role) || requiredScopes.some((scope) => !scopes.includes(scope))) {
          options.reportRefusal?.("claims_authority"); return refusal();
        }
        const sessionId = stableUuid(`${options.issuer}\0${tenantId}\0${subject}\0${claimString(payload, "sid") ?? payload.jti ?? "default"}`);
        const principal = await options.repository.upsertOidcPrincipal({
          tenantId, issuer: options.issuer, subject,
          email: claimString(payload, "email"),
          displayName: claimString(payload, "name"), role, sessionId, clientType: "mcp",
        });
        if (principal === null) { options.reportRefusal?.("tenant_repository"); return refusal(); }
        const issuedAtMs = payload.iat * 1000;
        const expiresAtMs = payload.exp * 1000;
        return Object.freeze({ ok: true as const, value: Object.freeze({
          contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
          actor: Object.freeze({ type: "user" as const, tenantId, userId: principal.userId, role,
            oidcIssuer: options.issuer, oidcSubject: subject }),
          session: Object.freeze({ sessionId, clientType: "mcp" as const, mcpSessionId: null,
            oauthClientId: claimString(payload, "azp") ?? claimString(payload, "client_id") }),
          principalKey: `${tenantId}:${principal.userId}`,
          issuedAtMs, expiresAtMs,
        }) });
      } catch {
        options.reportRefusal?.("tenant_repository");
        return refusal();
      }
    },
    async authenticateDevice() { return refusal(); },
  });
}

function refusal(): GatewayPortResult<never> {
  return Object.freeze({ ok: false as const, port: "identity" as const, code: "unavailable" as const,
    message: "OIDC bearer authentication refused" });
}

export function createOidcNorthMcpAuthenticator(input: {
  readonly identity: IdentityPort & { readonly kind: "oidc" };
  readonly resource: URL;
  readonly scopes?: readonly string[];
}): NorthMcpAuthenticator & { readonly kind: "oidc" } {
  const scopes = [...(input.scopes ?? ["mcp:read"])];
  return Object.freeze({
    kind: "oidc" as const,
    trust: Object.freeze({ mode: "production" as const, adapterKind: "oidc" as const, identity: input.identity }),
    async authenticate(request: IncomingMessage) {
      const result = await input.identity.authenticateNorthRequest({ authorization: request.headers.authorization });
      if (!result.ok) return null;
      const token = bearer(request.headers.authorization);
      if (token === null) return null;
      return Object.freeze({
        authInfo: Object.freeze({ token, clientId: result.value.session.oauthClientId ?? "oidc-client", scopes, resource: input.resource }),
        authContext: result.value,
        principalKey: result.value.principalKey,
      });
    },
  });
}
