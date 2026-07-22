import type {
  ArtifactEvidence,
  ComponentId,
  ComponentIdentity,
  ExecutionPlan,
  ProcessCommandDescriptor,
} from "./types.js";

export interface HarnessStartContext {
  plan: ExecutionPlan;
  evidenceRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface RunningHarnessComponent {
  componentId: ComponentId;
  pid: number;
  observedIdentity: ComponentIdentity;
  readyAt: string;
  stop(): Promise<{ stoppedAt: string; exitCode: number; artifacts: ArtifactEvidence[] }>;
}

export interface HarnessComponentAdapter {
  readonly componentId: ComponentId;
  describeCommand(plan: ExecutionPlan): ProcessCommandDescriptor;
  start(context: HarnessStartContext): Promise<RunningHarnessComponent>;
}

export interface ConformanceCaseExecutor {
  executeCase(caseId: string): Promise<unknown>;
}

// These are contracts only. O1-T3/T4/T5 implementations register adapters in a
// later change; this package intentionally starts no process and executes no case.
export type HarnessAdapterRegistry = Readonly<Partial<Record<ComponentId, HarnessComponentAdapter>>>;
