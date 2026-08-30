import {
  StrictJsonlProcess,
  StrictReadyProcess,
  boundedProcessDiagnostics,
  type JsonObject,
  type JsonValue,
  type ProcessDiagnosticSnapshot,
  type ProcessTranscriptRecord,
} from "./processHarness.js";
import type { ProcessCommandDescriptor } from "./types.js";

/**
 * WP-12 owns these names independently of the production stack vocabulary.
 * The class is intentionally a narrow actual-child-process wrapper: it has no
 * response implementation, plan loader, or simulator control path.
 */
export const REAL_TRIO_PROCESS_COMPONENT_IDS = Object.freeze([
  "gateway_production_conformance",
  "bridge_worker",
  "addin_loopback_fixture",
] as const);

export type RealTrioProcessComponent =
  (typeof REAL_TRIO_PROCESS_COMPONENT_IDS)[number];

export interface RealTrioProcessCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
}

export interface RealTrioProcessHarnessOptions {
  /** Mandatory caller-owned directory for redacted process evidence. */
  readonly evidenceDirectory: string;
}

export interface RealTrioReadyChild {
  readonly componentId: RealTrioProcessComponent;
  readonly readiness: JsonObject;
  readonly process: { readonly exitCode: number | null };
  readonly pid: number;
  readonly transcript: readonly ProcessTranscriptRecord[];
  diagnostics(phase: string): ProcessDiagnosticSnapshot;
  stop(): Promise<{ readonly exitCode: number | null; readonly killEscalated: boolean }>;
}

export interface RealTrioJsonlChild extends RealTrioReadyChild {
  request(action: string, fields?: Readonly<Record<string, JsonValue>>): Promise<JsonValue>;
  terminateForConformance(): Promise<{ readonly exitCode: number | null; readonly killEscalated: boolean }>;
}

function command(input: RealTrioProcessCommand): ProcessCommandDescriptor {
  return {
    executable: input.executable,
    args: [...input.args],
    workingDirectory: input.workingDirectory,
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 30_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 10_000 },
  };
}

/** Owns READY, STOP, restart inputs, transcripts, and child exit observation. */
export class RealTrioProcessHarness {
  public constructor(private readonly options: RealTrioProcessHarnessOptions) {}

  public async startReady(input: {
    readonly componentId: RealTrioProcessComponent;
    readonly command: RealTrioProcessCommand;
    readonly validateReadiness: (value: JsonObject) => void;
    readonly preReadyBootstrap?: Readonly<{
      readonly request: JsonObject;
      readonly timeoutMs: number;
      validateResponse(value: JsonObject): void;
    }>;
  }): Promise<RealTrioReadyChild> {
    const child = await StrictReadyProcess.start({
      // Strict process primitives are shared mechanics only.  The cast keeps
      // their historical identifier type from leaking into this contract.
      componentId: input.componentId as never,
      command: command(input.command),
      absoluteWorkingDirectory: input.command.workingDirectory,
      useTestSignalProxy: true,
      evidenceDirectory: this.options.evidenceDirectory,
      ...(input.preReadyBootstrap === undefined
        ? {}
        : { preReadyBootstrap: input.preReadyBootstrap }),
      validateReadiness: input.validateReadiness,
    });
    return Object.freeze({
      componentId: input.componentId,
      readiness: child.readiness,
      process: child.process,
      pid: child.pid,
      get transcript() { return child.transcript; },
      diagnostics: (phase: string) => boundedProcessDiagnostics({
        componentId: input.componentId,
        phase,
        exitCode: child.process.exitCode,
        transcript: child.transcript,
      }),
      stop: async () => await child.stop(),
    });
  }

  public async startJsonl(input: {
    readonly componentId: RealTrioProcessComponent;
    readonly command: RealTrioProcessCommand;
    readonly expectedReadinessFields: Readonly<Record<string, JsonValue>>;
    readonly requiredActions: readonly string[];
  }): Promise<RealTrioJsonlChild> {
    const child = await StrictJsonlProcess.start({
      componentId: input.componentId as never,
      command: command(input.command),
      absoluteWorkingDirectory: input.command.workingDirectory,
      expectedReadinessFields: input.expectedReadinessFields,
      requiredActions: input.requiredActions,
      evidenceDirectory: this.options.evidenceDirectory,
    });
    return Object.freeze({
      componentId: input.componentId,
      readiness: child.readiness,
      process: child.process,
      pid: child.pid,
      get transcript() { return child.transcript; },
      diagnostics: (phase: string) => boundedProcessDiagnostics({
        componentId: input.componentId,
        phase,
        exitCode: child.process.exitCode,
        transcript: child.transcript,
      }),
      request: async (
        action: string,
        fields: Readonly<Record<string, JsonValue>> = {},
      ) => await child.request(action, fields),
      terminateForConformance: async () => await child.terminateForConformance(),
      stop: async () => await child.stop(),
    });
  }
}
