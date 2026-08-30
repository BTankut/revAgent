export const GATEWAY_MAINTENANCE_MAX_OPERATIONS = 64;
export const GATEWAY_MAINTENANCE_COOPERATIVE_BUDGET_MS = 250;
export const GATEWAY_MAINTENANCE_INTERVAL_MS = 30_000;

export type GatewayMaintenanceLane =
  | "session_retention"
  | "session_migration_cleanup"
  | "resource_receipts"
  | "recovery_carriers"
  | "protected_key_inventory";

const ORDERED_LANES: readonly GatewayMaintenanceLane[] = Object.freeze([
  "session_retention",
  "session_migration_cleanup",
  "resource_receipts",
  "recovery_carriers",
  "protected_key_inventory",
]);

export interface GatewayMaintenanceCursor {
  readonly lane: GatewayMaintenanceLane;
  readonly tenantAfter: string | null;
  readonly keyAfter: string | null;
}
export interface GatewayMaintenanceStepResult {
  readonly operations: number;
  readonly cursor: GatewayMaintenanceCursor;
  readonly progressed: boolean;
  readonly retryNeeded: boolean;
}

export interface GatewayMaintenanceOwner {
  readonly identity: string;
  readonly epoch: number;
  isCurrent(): boolean;
}

export interface GatewayMaintenanceDependencies {
  readonly owner: GatewayMaintenanceOwner;
  readonly now: () => number;
  runStep(input: {
    readonly cursor: GatewayMaintenanceCursor;
    readonly remainingOperations: number;
    readonly deadlineMs: number;
  }): Promise<GatewayMaintenanceStepResult>;
  observeFailure?(input: {
    readonly lane: GatewayMaintenanceLane;
    readonly errorClass: "unavailable" | "invalid_record" | "unknown";
  }): void;
}

export interface GatewayMaintenancePassResult {
  readonly operations: number;
  readonly elapsedMs: number;
  readonly cursor: GatewayMaintenanceCursor;
  readonly stoppedReason:
    | "complete"
    | "operation_budget"
    | "cooperative_budget"
    | "owner_lost"
    | "retry_needed";
}

function nextLane(lane: GatewayMaintenanceLane): GatewayMaintenanceLane {
  const index = ORDERED_LANES.indexOf(lane);
  return ORDERED_LANES[(index + 1) % ORDERED_LANES.length]!;
}

function initialCursor(): GatewayMaintenanceCursor {
  return Object.freeze({
    lane: ORDERED_LANES[0]!,
    tenantAfter: null,
    keyAfter: null,
  });
}

/** One host-owned, non-overlapping, bounded maintenance scheduler. */
export class GatewayMaintenanceCoordinator {
  readonly #dependencies: GatewayMaintenanceDependencies;
  #state: "stopped" | "starting" | "running" | "stopping" = "stopped";
  #cursor: GatewayMaintenanceCursor = initialCursor();
  #pass: Promise<GatewayMaintenancePassResult> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(dependencies: GatewayMaintenanceDependencies) {
    this.#dependencies = dependencies;
  }

  public get state(): string { return this.#state; }
  public get cursor(): GatewayMaintenanceCursor { return this.#cursor; }

  public start(): void {
    if (this.#state === "running" || this.#state === "starting") return;
    if (!this.#dependencies.owner.isCurrent()) {
      throw new Error("Gateway maintenance owner is unavailable");
    }
    this.#state = "starting";
    this.#state = "running";
    this.#schedule();
  }

  public runNow(): Promise<GatewayMaintenancePassResult> {
    if (this.#state !== "running") {
      return Promise.resolve(Object.freeze({
        operations: 0,
        elapsedMs: 0,
        cursor: this.#cursor,
        stoppedReason: "owner_lost" as const,
      }));
    }
    if (this.#pass !== null) return this.#pass;
    this.#pass = this.#runPass().finally(() => { this.#pass = null; });
    return this.#pass;
  }

  async #runPass(): Promise<GatewayMaintenancePassResult> {
    const startedAtMs = this.#dependencies.now();
    const deadlineMs = startedAtMs + GATEWAY_MAINTENANCE_COOPERATIVE_BUDGET_MS;
    let operations = 0;
    let cursor = this.#cursor;
    let stoppedReason: GatewayMaintenancePassResult["stoppedReason"] = "complete";
    let lanesWithoutProgress = 0;
    while (operations < GATEWAY_MAINTENANCE_MAX_OPERATIONS) {
      if (!this.#dependencies.owner.isCurrent() || this.#state !== "running") {
        stoppedReason = "owner_lost";
        break;
      }
      if (this.#dependencies.now() >= deadlineMs) {
        stoppedReason = "cooperative_budget";
        break;
      }
      let result: GatewayMaintenanceStepResult;
      try {
        result = await this.#dependencies.runStep({
          cursor,
          remainingOperations: GATEWAY_MAINTENANCE_MAX_OPERATIONS - operations,
          deadlineMs,
        });
      } catch (error) {
        this.#dependencies.observeFailure?.({
          lane: cursor.lane,
          errorClass: error instanceof TypeError ? "invalid_record" : "unknown",
        });
        result = Object.freeze({
          operations: 0,
          cursor: Object.freeze({
            lane: nextLane(cursor.lane),
            tenantAfter: null,
            keyAfter: null,
          }),
          progressed: false,
          retryNeeded: true,
        });
      }
      if (!Number.isSafeInteger(result.operations) || result.operations < 0 ||
          result.operations > GATEWAY_MAINTENANCE_MAX_OPERATIONS - operations) {
        throw new Error("Gateway maintenance step escaped its operation budget");
      }
      operations += result.operations;
      cursor = result.cursor;
      this.#cursor = cursor;
      if (result.retryNeeded) {
        stoppedReason = "retry_needed";
        // A stuck first key must not starve other lanes.
        cursor = Object.freeze({
          lane: nextLane(cursor.lane),
          tenantAfter: null,
          keyAfter: null,
        });
        this.#cursor = cursor;
        lanesWithoutProgress += 1;
      } else if (result.progressed) {
        lanesWithoutProgress = 0;
      } else {
        lanesWithoutProgress += 1;
        cursor = Object.freeze({
          lane: nextLane(cursor.lane),
          tenantAfter: null,
          keyAfter: null,
        });
        this.#cursor = cursor;
      }
      if (operations === GATEWAY_MAINTENANCE_MAX_OPERATIONS) {
        stoppedReason = "operation_budget";
        break;
      }
      if (lanesWithoutProgress >= ORDERED_LANES.length) {
        if (stoppedReason !== "retry_needed") stoppedReason = "complete";
        break;
      }
    }
    return Object.freeze({
      operations,
      elapsedMs: Math.max(0, this.#dependencies.now() - startedAtMs),
      cursor: this.#cursor,
      stoppedReason,
    });
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#pass;
    this.#state = "stopped";
  }

  #schedule(): void {
    if (this.#state !== "running" || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.runNow().finally(() => this.#schedule());
    }, GATEWAY_MAINTENANCE_INTERVAL_MS);
    this.#timer.unref();
  }
}
