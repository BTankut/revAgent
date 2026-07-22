import type {
  BindingKind,
  FaultDirection,
  FrameFaultRule,
  OpeningFaultRule,
} from "./types.js";

interface DeferredDelivery {
  connectionId: string;
  direction: FaultDirection;
  deliver: () => Promise<void>;
  completion: Promise<FrameDeliveryCompletion>;
  operation: Promise<void> | null;
  isSettled(): boolean;
  settle(completion: FrameDeliveryCompletion): boolean;
}

interface ScheduledDelivery extends DeferredDelivery {
  timer: NodeJS.Timeout;
}

export type FrameDeliveryOutcome = "delivered" | "dropped" | "deferred";
export type FrameDeliveryCompletion =
  | { state: "delivered" }
  | { state: "dropped" }
  | { state: "cancelled"; reason: string }
  | { state: "failed"; error: unknown };

export interface FrameDeliveryResult {
  outcome: FrameDeliveryOutcome;
  completion: Promise<FrameDeliveryCompletion>;
}

export interface FlushHeldResult {
  selected: number;
  delivered: number;
  cancelled: number;
  failed: number;
}

function completed(result: FrameDeliveryCompletion): Promise<FrameDeliveryCompletion> {
  return Promise.resolve(result);
}

function deferredDelivery(
  connectionId: string,
  direction: FaultDirection,
  deliver: () => Promise<void>,
): DeferredDelivery {
  let settled = false;
  let settle: (completion: FrameDeliveryCompletion) => void = () => undefined;
  const completion = new Promise<FrameDeliveryCompletion>((resolve) => { settle = resolve; });
  return {
    connectionId,
    direction,
    deliver,
    completion,
    operation: null,
    isSettled: () => settled,
    settle: (result) => {
      if (settled) return false;
      settled = true;
      settle(result);
      return true;
    },
  };
}

const MATCHABLE_MESSAGE_TYPES: Readonly<Record<FaultDirection, ReadonlySet<string>>> = {
  gateway_to_bridge: new Set([
    "hello_ack",
    "session_registered",
    "resume_ack",
    "heartbeat_ack",
    "invoke",
    "invoke_batch",
    "error",
    "cancel",
    "manifest_info",
  ]),
  bridge_to_gateway: new Set([
    "session_register",
    "session_resume",
    "session_unregister",
    "heartbeat",
    "result",
    "chunk",
    "progress",
    "error",
    "doc_context_update",
    "manifest_check",
    "goodbye",
  ]),
};

export function isFrameFaultMessageType(direction: FaultDirection, value: string): boolean {
  return MATCHABLE_MESSAGE_TYPES[direction].has(value);
}

export class FaultController {
  private frameRules: FrameFaultRule[] = [];
  private openingRules: OpeningFaultRule[] = [];
  private held: DeferredDelivery[] = [];
  private scheduled = new Set<ScheduledDelivery>();
  private flushing = new Set<DeferredDelivery>();
  private inFlight = new Set<DeferredDelivery>();
  private bufferedSse = new Set<string>();
  private closingConnections = new Set<string>();
  private closing = false;

  enqueueFrame(rule: FrameFaultRule): void {
    if (this.closing) {
      throw new Error("fault controller is closed");
    }
    if (rule.direction !== "gateway_to_bridge" && rule.direction !== "bridge_to_gateway") {
      throw new TypeError("frame fault direction is invalid");
    }
    if (rule.action !== "drop" && rule.action !== "duplicate" && rule.action !== "delay" && rule.action !== "hold") {
      throw new TypeError("frame fault action is invalid");
    }
    if (rule.binding !== undefined && rule.binding !== "wss" && rule.binding !== "http_sse") {
      throw new TypeError("frame fault binding is invalid");
    }
    if (rule.messageType !== undefined &&
      (typeof rule.messageType !== "string" || !isFrameFaultMessageType(rule.direction, rule.messageType))) {
      throw new TypeError("frame fault messageType cannot match the selected direction");
    }
    const remaining = rule.remaining ?? 1;
    if (!Number.isSafeInteger(remaining) || remaining < 1) {
      throw new TypeError("fault remaining must be a positive safe integer");
    }
    if (rule.action === "delay" && (!Number.isSafeInteger(rule.delayMs) || (rule.delayMs ?? -1) < 0)) {
      throw new TypeError("delay fault requires a non-negative delayMs");
    }
    if (rule.action !== "delay" && rule.delayMs !== undefined) {
      throw new TypeError("delayMs is valid only for a delay frame fault");
    }
    this.frameRules.push({ ...rule, remaining });
  }

  enqueueOpening(rule: OpeningFaultRule): void {
    if (this.closing) {
      throw new Error("fault controller is closed");
    }
    if (rule.binding !== "wss" && rule.binding !== "http_sse") {
      throw new TypeError("opening fault binding is invalid");
    }
    const remaining = rule.remaining ?? 1;
    if (!Number.isSafeInteger(remaining) || remaining < 1) {
      throw new TypeError("opening fault remaining must be a positive safe integer");
    }
    if (!Number.isSafeInteger(rule.status) || rule.status < 400 || rule.status > 599) {
      throw new TypeError("opening fault status must be an HTTP error status");
    }
    if (rule.retryAfter !== undefined) {
      if (
        typeof rule.retryAfter !== "string" ||
        rule.retryAfter.length === 0 ||
        rule.retryAfter.length > 128 ||
        /[\r\n]/u.test(rule.retryAfter)
      ) {
        throw new TypeError("opening fault retryAfter must be a bounded HTTP Retry-After value");
      }
      const deltaSeconds = /^(?:0|[1-9][0-9]{0,9})$/u.test(rule.retryAfter);
      const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u.test(rule.retryAfter) &&
        Number.isFinite(Date.parse(rule.retryAfter));
      if (!deltaSeconds && !httpDate) {
        throw new TypeError("opening fault retryAfter must be delay-seconds or IMF-fixdate");
      }
    }
    this.openingRules.push({ ...rule, remaining });
  }

  consumeOpening(binding: BindingKind): OpeningFaultRule | null {
    const index = this.openingRules.findIndex((rule) => rule.binding === binding);
    if (index < 0) {
      return null;
    }
    const rule = this.openingRules[index]!;
    rule.remaining = (rule.remaining ?? 1) - 1;
    if (rule.remaining === 0) {
      this.openingRules.splice(index, 1);
    }
    return { ...rule };
  }

  setSseBuffering(connectionId: string, enabled: boolean): void {
    if (enabled) {
      this.bufferedSse.add(connectionId);
    } else {
      this.bufferedSse.delete(connectionId);
    }
  }

  isSseBuffered(connectionId: string): boolean {
    return this.bufferedSse.has(connectionId);
  }

  async apply(
    connectionId: string,
    binding: BindingKind,
    direction: FaultDirection,
    messageType: string,
    deliver: () => Promise<void>,
  ): Promise<FrameDeliveryResult> {
    if (this.closing || this.closingConnections.has(connectionId)) {
      throw new Error("fault controller is closed");
    }
    if (direction === "gateway_to_bridge" && binding === "http_sse" && this.bufferedSse.has(connectionId)) {
      const deferred = deferredDelivery(connectionId, direction, deliver);
      this.held.push(deferred);
      return { outcome: "deferred", completion: deferred.completion };
    }

    const index = this.frameRules.findIndex(
      (rule) =>
        rule.direction === direction &&
        (rule.binding === undefined || rule.binding === binding) &&
        (rule.messageType === undefined || rule.messageType === messageType),
    );
    if (index < 0) {
      const delivery = deferredDelivery(connectionId, direction, deliver);
      await this.complete(delivery);
      return { outcome: "delivered", completion: delivery.completion };
    }

    const rule = this.frameRules[index]!;
    rule.remaining = (rule.remaining ?? 1) - 1;
    if (rule.remaining === 0) {
      this.frameRules.splice(index, 1);
    }

    switch (rule.action) {
      case "drop":
        return { outcome: "dropped", completion: completed({ state: "dropped" }) };
      case "duplicate":
        {
          const delivery = deferredDelivery(connectionId, direction, async () => {
            await deliver();
            if (!delivery.isSettled()) await deliver();
          });
          await this.complete(delivery);
          return { outcome: "delivered", completion: delivery.completion };
        }
      case "hold":
        {
          const deferred = deferredDelivery(connectionId, direction, deliver);
          this.held.push(deferred);
          return { outcome: "deferred", completion: deferred.completion };
        }
      case "delay": {
        const deferred = deferredDelivery(connectionId, direction, deliver);
        const scheduled: ScheduledDelivery = {
          ...deferred,
          timer: undefined as unknown as NodeJS.Timeout,
        };
        scheduled.timer = setTimeout(() => {
          this.scheduled.delete(scheduled);
          void this.complete(scheduled).catch(() => undefined);
        }, rule.delayMs ?? 0);
        scheduled.timer.unref();
        this.scheduled.add(scheduled);
        return { outcome: "deferred", completion: deferred.completion };
      }
      default:
        throw new TypeError("frame fault action is invalid");
    }
  }

  private complete(delivery: DeferredDelivery): Promise<void> {
    if (delivery.operation !== null) {
      return delivery.operation;
    }
    // Defer the callback by one microtask so the operation is visible to a
    // re-entrant cancelConnection() invoked from inside deliver().
    const operation = Promise.resolve().then(async () => {
      if (delivery.isSettled()) return;
      try {
        await delivery.deliver();
        delivery.settle({ state: "delivered" });
      } catch (error) {
        if (delivery.settle({ state: "failed", error })) throw error;
      }
    });
    delivery.operation = operation;
    this.inFlight.add(delivery);
    void operation.then(
      () => this.inFlight.delete(delivery),
      () => this.inFlight.delete(delivery),
    );
    return operation;
  }

  cancelConnection(connectionId: string): void {
    this.closingConnections.add(connectionId);
    const retained: DeferredDelivery[] = [];
    for (const delivery of this.held) {
      if (delivery.connectionId === connectionId) {
        delivery.settle({ state: "cancelled", reason: "connection_closed" });
      } else {
        retained.push(delivery);
      }
    }
    this.held = retained;
    this.bufferedSse.delete(connectionId);
    for (const scheduled of [...this.scheduled]) {
      if (scheduled.connectionId === connectionId) {
        clearTimeout(scheduled.timer);
        this.scheduled.delete(scheduled);
        scheduled.settle({ state: "cancelled", reason: "connection_closed" });
      }
    }
    for (const delivery of this.inFlight) {
      if (delivery.connectionId === connectionId) {
        delivery.settle({ state: "cancelled", reason: "connection_closed" });
      }
    }
    for (const delivery of this.flushing) {
      if (delivery.connectionId === connectionId) {
        delivery.settle({ state: "cancelled", reason: "connection_closed" });
      }
    }
  }

  async waitForConnection(connectionId: string): Promise<void> {
    while (true) {
      const operations = [...this.inFlight]
        .filter((delivery) => delivery.connectionId === connectionId)
        .map((delivery) => delivery.operation)
        .filter((operation): operation is Promise<void> => operation !== null);
      if (operations.length === 0) return;
      await Promise.allSettled(operations);
    }
  }

  clearConnection(connectionId: string): Promise<void> {
    this.cancelConnection(connectionId);
    return this.waitForConnection(connectionId);
  }

  async flushHeld(connectionId?: string): Promise<FlushHeldResult> {
    const selected: DeferredDelivery[] = [];
    const retained: DeferredDelivery[] = [];
    for (const delivery of this.held) {
      if (connectionId === undefined || delivery.connectionId === connectionId) {
        selected.push(delivery);
      } else {
        retained.push(delivery);
      }
    }
    this.held = retained;
    if (connectionId !== undefined) {
      this.bufferedSse.delete(connectionId);
    }
    for (const delivery of selected) this.flushing.add(delivery);
    try {
      for (const delivery of selected) {
        try {
          await this.complete(delivery);
        } catch {
          // The settle-once completion below is the public, serializable result.
        }
      }
    } finally {
      for (const delivery of selected) this.flushing.delete(delivery);
    }
    const completions = await Promise.all(selected.map(async (delivery) => delivery.completion));
    return {
      selected: selected.length,
      delivered: completions.filter((completion) => completion.state === "delivered").length,
      cancelled: completions.filter((completion) => completion.state === "cancelled").length,
      failed: completions.filter((completion) => completion.state === "failed").length,
    };
  }

  async clear(): Promise<void> {
    this.closing = true;
    this.frameRules = [];
    this.openingRules = [];
    for (const delivery of this.held) {
      delivery.settle({ state: "cancelled", reason: "fault_controller_closed" });
    }
    this.held = [];
    this.bufferedSse.clear();
    for (const scheduled of this.scheduled) {
      clearTimeout(scheduled.timer);
      scheduled.settle({ state: "cancelled", reason: "fault_controller_closed" });
    }
    this.scheduled.clear();
    for (const delivery of this.inFlight) {
      delivery.settle({ state: "cancelled", reason: "fault_controller_closed" });
    }
    for (const delivery of this.flushing) {
      delivery.settle({ state: "cancelled", reason: "fault_controller_closed" });
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled(
        [...this.inFlight]
          .map((delivery) => delivery.operation)
          .filter((operation): operation is Promise<void> => operation !== null),
      );
    }
  }

  snapshot(): {
    heldInboundFrames: number;
    heldOutboundFrames: number;
    bufferedSseConnections: string[];
    activeTimers: number;
    activeDeliveries: number;
  } {
    return {
      heldInboundFrames: this.held.filter((entry) => entry.direction === "bridge_to_gateway").length,
      heldOutboundFrames: this.held.filter((entry) => entry.direction === "gateway_to_bridge").length,
      bufferedSseConnections: [...this.bufferedSse].sort(),
      activeTimers: this.scheduled.size,
      activeDeliveries: this.inFlight.size,
    };
  }
}
