import type { GatewayRegistryView } from "./registry.js";

/**
 * Mode B ships as non-executable interfaces only (GW-2 / P-GW-8).
 *
 * The acceptance criterion is that these interfaces typecheck and that any
 * attempted execution fails closed as `not_implemented`, with no runtime side
 * effects and no configuration. This module therefore has no module-level
 * state, emits no events, reads no config, and exports no capability value —
 * a shipped constant asserting what Mode B can do would itself be
 * configuration.
 *
 * Every type the specification leaves open is an opaque brand rather than a
 * guess. Inventing a sandbox scope, a resource-limit shape or a file manifest
 * here would smuggle filesystem and egress decisions into a shell that is
 * explicitly not allowed to make them.
 */
export type ConversationProjection = { readonly __brand: "revagent.mode-b.projection" };
export type ProviderRequest = { readonly __brand: "revagent.mode-b.provider-request" };
export type ProviderResponse = { readonly __brand: "revagent.mode-b.provider-response" };
export type EngineAction = { readonly __brand: "revagent.mode-b.engine-action" };
export type SandboxScope = { readonly __brand: "revagent.mode-b.sandbox-scope" };
export type SandboxScript = { readonly __brand: "revagent.mode-b.sandbox-script" };
export type SandboxLimits = { readonly __brand: "revagent.mode-b.sandbox-limits" };
export type SandboxSession = { readonly __brand: "revagent.mode-b.sandbox-session" };
export type SandboxExecResult = { readonly __brand: "revagent.mode-b.sandbox-exec-result" };
export type FileManifest = { readonly __brand: "revagent.mode-b.file-manifest" };

export type EngineModeKind = "tool_calling" | "code_exec";

/** Shape only. No values are asserted for any model. */
export interface ModelCapabilities {
  readonly supports_tool_search: boolean;
  readonly supports_code_exec: boolean;
}

export interface EngineMode {
  readonly mode: EngineModeKind;
  prepareTurn(projection: ConversationProjection): ProviderRequest;
  interpretResponse(response: ProviderResponse): readonly EngineAction[];
}

export interface SandboxHost {
  readonly toolRpcEndpoint: URL | null;
  createSession(scope: SandboxScope): Promise<SandboxSession>;
  exec(script: SandboxScript, limits: SandboxLimits): Promise<SandboxExecResult>;
}

export class ModeBNotImplementedError extends Error {
  readonly code = "not_implemented" as const;
  readonly port = "engine_mode" as const;
  constructor(
    readonly modeBInterface: "EngineMode" | "SandboxHost" | "generateToolWrapperTree",
  ) {
    super(
      `Mode B is not implemented in Phase 1: ${modeBInterface} is an interface stub`,
    );
    this.name = "ModeBNotImplementedError";
  }
}

/**
 * The concrete members are typed `never` while the interface keeps the declared
 * return types.
 *
 * `never` is assignable to anything, so `implements EngineMode` still holds and
 * the published contract stays faithful, but every expression that consumes a
 * call is typed `never` — the compiler stops a caller from building on a
 * result that will not exist.
 *
 * These throw rather than returning a refusal object. Returning `{ok:false}`
 * would mean widening signatures the specification fixes, and a thrown typed
 * error cannot be ignored by a caller that forgets to check a flag. They are
 * also real functions rather than `declare`d ones: a `declare` emits no
 * JavaScript, so calling it fails as "undefined is not a function" — an
 * unstructured failure, which is exactly what fail-closed forbids.
 */
export class CodeExecMode implements EngineMode {
  readonly mode = "code_exec" as const;

  prepareTurn(): never {
    throw new ModeBNotImplementedError("EngineMode");
  }

  interpretResponse(): never {
    throw new ModeBNotImplementedError("EngineMode");
  }
}

export const codeExecSandboxHost: SandboxHost = {
  toolRpcEndpoint: null,
  createSession(): Promise<never> {
    throw new ModeBNotImplementedError("SandboxHost");
  },
  exec(): Promise<never> {
    throw new ModeBNotImplementedError("SandboxHost");
  },
};

/**
 * Typed as a declaration so the published signature keeps the registry-view
 * parameter the specification names, while the implementation takes none —
 * there is nothing to do with it, and a named-but-unused parameter is a lint
 * error rather than documentation.
 */
export const generateToolWrapperTree: (
  registryView: GatewayRegistryView,
) => never = () => {
  throw new ModeBNotImplementedError("generateToolWrapperTree");
};
