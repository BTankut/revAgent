import { createHash } from "node:crypto";
import type { EntitledCatalogView } from "./entitledRegistry.js";
import type {
  GatewayExecutorBinding,
  GatewayPolicyClass,
} from "./registry.js";

export const GATEWAY_INSTRUCTION_PACKAGE_SCHEMA =
  "revagent-instruction-package/v1" as const;
export const GATEWAY_O6_MODULE_MANIFEST_SCHEMA =
  "revagent-o6-module-manifest/v1" as const;
export const PHASE1_INSTRUCTION_VERSION = "1.0.0" as const;

const MODULE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

const PHASE1_INSTRUCTION_TEXT = `# revAgent Phase 1 remote MCP instructions

- Use only the remote, published tool names exposed by the entitled capability index. Legacy local tool names and local stdio registrations are not callable through this Gateway.
- The external MCP client owns conversation context, planning, model calls, retries, and the agentic loop. The Gateway does not run a model, select tools, or receive a prompt injection copy of this document.
- For a confirm-class tool, request the server preview first. Commit only by re-invoking the same remote tool with the server-issued confirmation token and originating preview correlation; never manufacture either value.
- Treat returned revagent://artifact and revagent://result resources as authenticated, scoped, expiring references. Read those resources through MCP instead of assuming a Gateway-local or workstation-local file path.
- Use the capability index and deferred tool_search/tool_schema surfaces for discovery. A missing tool or module is not entitled and must not be inferred from another principal's catalog.
`;

export interface GatewayInstructionDocument {
  readonly module: string;
  readonly version: string;
  readonly uri: string;
  readonly mimeType: "text/markdown";
  readonly digest: string;
  readonly text: string;
}

export interface GatewayO6ToolBinding {
  readonly name: string;
  readonly version: string;
  readonly policyClass: GatewayPolicyClass;
  readonly executor: GatewayExecutorBinding;
  readonly executorMethod: string;
}

export interface GatewayO6ModuleManifest {
  readonly schemaVersion: typeof GATEWAY_O6_MODULE_MANIFEST_SCHEMA;
  readonly module: string;
  readonly moduleVersion: string;
  readonly instruction: {
    readonly version: string;
    readonly uri: string;
    readonly digest: string;
  };
  /** Digest of the exact entitled tool set represented by this manifest. */
  readonly entitlementDigest: string;
  readonly tools: readonly GatewayO6ToolBinding[];
  readonly manifestDigest: string;
}

export interface GatewayInstructionModulePackage {
  readonly instruction: GatewayInstructionDocument;
  readonly manifest: GatewayO6ModuleManifest;
  readonly manifestUri: string;
  readonly manifestBytes: string;
}

export interface GatewayInstructionPackage {
  readonly schemaVersion: typeof GATEWAY_INSTRUCTION_PACKAGE_SCHEMA;
  readonly instructionVersion: string;
  readonly modules: readonly GatewayInstructionModulePackage[];
}

export class GatewayInstructionPackageError extends Error {
  public constructor(
    readonly code:
      | "instruction_version_unavailable"
      | "module_name_invalid",
    message: string,
  ) {
    super(message);
    this.name = "GatewayInstructionPackageError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function instructionText(version: string): string {
  if (version !== PHASE1_INSTRUCTION_VERSION) {
    throw new GatewayInstructionPackageError(
      "instruction_version_unavailable",
      `instruction version ${version} is not packaged`,
    );
  }
  return PHASE1_INSTRUCTION_TEXT;
}

/**
 * Builds the O6 package from the same entitlement-filtered GW-3 view used by
 * tools/list, search, schema delivery, and dispatch.
 *
 * Empty or unentitled modules are absent rather than described as disabled.
 * The selected instruction version is an independent package pin, so a later
 * engine can retain an older instruction document without changing any tool
 * input schema or registry record.
 */
export function buildGatewayInstructionPackage(
  catalogView: Pick<EntitledCatalogView, "entries">,
  version: string = PHASE1_INSTRUCTION_VERSION,
): GatewayInstructionPackage {
  const text = instructionText(version);
  const byModule = new Map<
    string,
    ReturnType<EntitledCatalogView["entries"]>[number][]
  >();
  for (const entry of catalogView.entries()) {
    if (!MODULE_NAME_PATTERN.test(entry.namespace)) {
      throw new GatewayInstructionPackageError(
        "module_name_invalid",
        `catalog namespace ${entry.namespace} is not a valid O6 module name`,
      );
    }
    const entries = byModule.get(entry.namespace) ?? [];
    entries.push(entry);
    byModule.set(entry.namespace, entries);
  }

  const modules = [...byModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleName, entries]): GatewayInstructionModulePackage => {
      const tools = Object.freeze(
        entries
          .map((entry) =>
            Object.freeze({
              name: entry.name,
              version: entry.version,
              policyClass: entry.policyClass,
              executor: entry.executor,
              executorMethod: entry.tool,
            }),
          )
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
      const instructionUri = `revagent://instructions/${moduleName}/${version}`;
      const document = Object.freeze({
        module: moduleName,
        version,
        uri: instructionUri,
        mimeType: "text/markdown" as const,
        digest: digest(text),
        text,
      });
      const manifestBody = Object.freeze({
        schemaVersion: GATEWAY_O6_MODULE_MANIFEST_SCHEMA,
        module: moduleName,
        moduleVersion: version,
        instruction: Object.freeze({
          version,
          uri: instructionUri,
          digest: document.digest,
        }),
        entitlementDigest: digest(
          `${canonicalize(tools.map((tool) => tool.name))}\n`,
        ),
        tools,
      });
      const manifest = Object.freeze({
        ...manifestBody,
        manifestDigest: digest(`${canonicalize(manifestBody)}\n`),
      });
      const manifestUri = `revagent://modules/${moduleName}/${version}/manifest`;
      return Object.freeze({
        instruction: document,
        manifest,
        manifestUri,
        manifestBytes: `${canonicalize(manifest)}\n`,
      });
    });

  return Object.freeze({
    schemaVersion: GATEWAY_INSTRUCTION_PACKAGE_SCHEMA,
    instructionVersion: version,
    modules: Object.freeze(modules),
  });
}

/** Client initialization text points at the exact entitled, pinned resources. */
export function gatewayClientInstructions(
  instructionPackage: GatewayInstructionPackage,
): string {
  if (instructionPackage.modules.length === 0) {
    return "No revAgent instruction module is entitled for this principal.";
  }
  return instructionPackage.modules
    .map(
      (modulePackage) =>
        `${modulePackage.instruction.text}\nInstruction resource: ${modulePackage.instruction.uri}\nO6 manifest: ${modulePackage.manifestUri}`,
    )
    .join("\n\n");
}
