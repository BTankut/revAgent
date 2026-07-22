import type {
  BindingKind,
  FaultDirection,
  FrameFaultRule,
  OpeningFaultRule,
} from "./types.js";

interface HeldDelivery {
  connectionId: string;
  direction: FaultDirection;
  deliver: () => Promise<void>;
}

interface ScheduledDelivery {
  connectionId: string;
  timer: NodeJS.Timeout;
}

export type FrameDeliveryOutcome = "delivered" | "dropped" | "deferred";

export class FaultController {
  private frameRules: FrameFaultRule[] = [];
  private openingRules: OpeningFaultRule[] = [];
  private held: HeldDelivery[] = [];
  private scheduled = new Set<ScheduledDelivery>();
  private bufferedSse = new Set<string>();

  enqueueFrame(rule: FrameFaultRule): void {
    const remaining = rule.remaining ?? 1;
    if (!Number.isSafeInteger(remaining) || remaining < 1) {
      throw new TypeError("fault remaining must be a positive safe integer");
    }
    if (rule.action === "delay" && (!Number.isSafeInteger(rule.delayMs) || (rule.delayMs ?? -1) < 0)) {
      throw new TypeError("delay fault requires a non-negative delayMs");
    }
    this.frameRules.push({ ...rule, remaining });
  }

  enqueueOpening(rule: OpeningFaultRule): void {
    const remaining = rule.remaining ?? 1;
    if (!Number.isSafeInteger(remaining) || remaining < 1) {
      throw new TypeError("opening fault remaining must be a positive safe integer");
    }
    if (!Number.isSafeInteger(rule.status) || rule.status < 400 || rule.status > 599) {
      throw new TypeError("opening fault status must be an HTTP error status");
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
  ): Promise<FrameDeliveryOutcome> {
    if (direction === "gateway_to_bridge" && binding === "http_sse" && this.bufferedSse.has(connectionId)) {
      this.held.push({ connectionId, direction, deliver });
      return "deferred";
    }

    const index = this.frameRules.findIndex(
      (rule) =>
        rule.direction === direction &&
        (rule.binding === undefined || rule.binding === binding) &&
        (rule.messageType === undefined || rule.messageType === messageType),
    );
    if (index < 0) {
      await deliver();
      return "delivered";
    }

    const rule = this.frameRules[index]!;
    rule.remaining = (rule.remaining ?? 1) - 1;
    if (rule.remaining === 0) {
      this.frameRules.splice(index, 1);
    }

    switch (rule.action) {
      case "drop":
        return "dropped";
      case "duplicate":
        await deliver();
        await deliver();
        return "delivered";
      case "hold":
        this.held.push({ connectionId, direction, deliver });
        return "deferred";
      case "delay": {
        const scheduled: ScheduledDelivery = {
          connectionId,
          timer: undefined as unknown as NodeJS.Timeout,
        };
        scheduled.timer = setTimeout(() => {
          this.scheduled.delete(scheduled);
          void deliver().catch(() => undefined);
        }, rule.delayMs ?? 0);
        scheduled.timer.unref();
        this.scheduled.add(scheduled);
        return "deferred";
      }
    }
  }

  clearConnection(connectionId: string): void {
    this.held = this.held.filter((delivery) => delivery.connectionId !== connectionId);
    this.bufferedSse.delete(connectionId);
    for (const scheduled of [...this.scheduled]) {
      if (scheduled.connectionId === connectionId) {
        clearTimeout(scheduled.timer);
        this.scheduled.delete(scheduled);
      }
    }
  }

  async flushHeld(connectionId?: string): Promise<number> {
    const selected: HeldDelivery[] = [];
    const retained: HeldDelivery[] = [];
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
    for (const delivery of selected) {
      await delivery.deliver();
    }
    return selected.length;
  }

  clear(): void {
    this.frameRules = [];
    this.openingRules = [];
    this.held = [];
    this.bufferedSse.clear();
    for (const scheduled of this.scheduled) {
      clearTimeout(scheduled.timer);
    }
    this.scheduled.clear();
  }

  snapshot(): {
    heldOutboundFrames: number;
    bufferedSseConnections: string[];
    activeTimers: number;
  } {
    return {
      heldOutboundFrames: this.held.filter((entry) => entry.direction === "gateway_to_bridge").length,
      bufferedSseConnections: [...this.bufferedSse].sort(),
      activeTimers: this.scheduled.size,
    };
  }
}
