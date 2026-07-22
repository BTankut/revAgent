import { describe, expect, it } from "vitest";

import { FaultController } from "../src/faults.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("FaultController deferred delivery settlement", () => {
  it("settles cancellation immediately but keeps connection close behind the real delayed callback", async () => {
    const faults = new FaultController();
    const started = deferred();
    const release = deferred();
    let finished = false;
    faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "delay",
      messageType: "result",
      delayMs: 0,
    });
    const delivery = await faults.apply(
      "connection-1",
      "http_sse",
      "bridge_to_gateway",
      "result",
      async () => {
        started.resolve();
        await release.promise;
        finished = true;
      },
    );

    await within(started.promise, "delayed delivery start");
    let connectionClosed = false;
    const closing = faults.clearConnection("connection-1").then(() => { connectionClosed = true; });
    await expect(within(delivery.completion, "delay cancellation")).resolves.toEqual({
      state: "cancelled",
      reason: "connection_closed",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(connectionClosed).toBe(false);
    expect(finished).toBe(false);

    release.resolve();
    await within(closing, "connection delivery barrier");
    expect(finished).toBe(true);
    await expect(delivery.completion).resolves.toEqual({
      state: "cancelled",
      reason: "connection_closed",
    });
    expect(faults.snapshot().activeTimers).toBe(0);
  });

  it("cancels both active and not-yet-started flush deliveries without a hang or late delivered result", async () => {
    const faults = new FaultController();
    const started = deferred();
    const release = deferred();
    let secondDeliveryCalls = 0;
    faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "hold",
      messageType: "result",
      remaining: 2,
    });
    const first = await faults.apply(
      "connection-2",
      "http_sse",
      "bridge_to_gateway",
      "result",
      async () => {
        started.resolve();
        await release.promise;
      },
    );
    const second = await faults.apply(
      "connection-2",
      "http_sse",
      "bridge_to_gateway",
      "result",
      async () => { secondDeliveryCalls += 1; },
    );

    const flush = faults.flushHeld("connection-2");
    await within(started.promise, "held flush start");
    const closing = faults.clearConnection("connection-2");
    await expect(within(first.completion, "active flush cancellation")).resolves.toEqual({
      state: "cancelled",
      reason: "connection_closed",
    });
    await expect(within(second.completion, "queued flush cancellation")).resolves.toEqual({
      state: "cancelled",
      reason: "connection_closed",
    });

    release.resolve();
    await within(closing, "connection flush barrier");
    await expect(within(flush, "cancelled flush completion")).resolves.toEqual({
      selected: 2,
      delivered: 0,
      cancelled: 2,
      failed: 0,
    });
    expect(secondDeliveryCalls).toBe(0);
    await expect(first.completion).resolves.toMatchObject({ state: "cancelled" });
    await expect(second.completion).resolves.toMatchObject({ state: "cancelled" });
  });

  it("tracks immediate and duplicate callbacks and suppresses a duplicate after cancellation", async () => {
    for (const action of [undefined, "duplicate"] as const) {
      const faults = new FaultController();
      const started = deferred();
      const release = deferred();
      let callbackCalls = 0;
      if (action !== undefined) {
        faults.enqueueFrame({
          direction: "bridge_to_gateway",
          binding: "wss",
          action,
          messageType: "heartbeat",
        });
      }
      const applying = faults.apply(
        `connection-${action ?? "immediate"}`,
        "wss",
        "bridge_to_gateway",
        "heartbeat",
        async () => {
          callbackCalls += 1;
          started.resolve();
          await release.promise;
        },
      );
      await within(started.promise, `${action ?? "immediate"} callback start`);
      let closeFinished = false;
      const closing = faults.clearConnection(`connection-${action ?? "immediate"}`)
        .then(() => { closeFinished = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(closeFinished).toBe(false);

      release.resolve();
      const delivery = await within(applying, `${action ?? "immediate"} apply completion`);
      await within(closing, `${action ?? "immediate"} close barrier`);
      expect(callbackCalls).toBe(1);
      await expect(delivery.completion).resolves.toEqual({
        state: "cancelled",
        reason: "connection_closed",
      });
    }
  });

  it("registers a duplicate operation before re-entrant cancellation from its first callback", async () => {
    const faults = new FaultController();
    const connectionId = "connection-reentrant-duplicate";
    let callbackCalls = 0;
    faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "wss",
      action: "duplicate",
      messageType: "heartbeat",
    });

    const delivery = await faults.apply(
      connectionId,
      "wss",
      "bridge_to_gateway",
      "heartbeat",
      async () => {
        callbackCalls += 1;
        faults.cancelConnection(connectionId);
      },
    );

    expect(callbackCalls).toBe(1);
    await expect(delivery.completion).resolves.toEqual({
      state: "cancelled",
      reason: "connection_closed",
    });
    await faults.waitForConnection(connectionId);
    expect(faults.snapshot().activeDeliveries).toBe(0);
  });

  it("does not finish clear until the actual in-flight callback has settled", async () => {
    const faults = new FaultController();
    const started = deferred();
    const release = deferred();
    let callbackFinished = false;
    faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "delay",
      messageType: "heartbeat",
      delayMs: 0,
    });
    const delivery = await faults.apply(
      "connection-3",
      "http_sse",
      "bridge_to_gateway",
      "heartbeat",
      async () => {
        started.resolve();
        await release.promise;
        callbackFinished = true;
      },
    );
    await within(started.promise, "delivery callback start");

    let clearFinished = false;
    const clearing = faults.clear().then(() => { clearFinished = true; });
    await expect(delivery.completion).resolves.toEqual({
      state: "cancelled",
      reason: "fault_controller_closed",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(clearFinished).toBe(false);
    expect(callbackFinished).toBe(false);
    expect(faults.snapshot().activeDeliveries).toBe(1);

    release.resolve();
    await within(clearing, "fault-controller close barrier");
    expect(callbackFinished).toBe(true);
    expect(faults.snapshot().activeDeliveries).toBe(0);
  });

  it("reports deferred callback failure only after the callback completes", async () => {
    const faults = new FaultController();
    const release = deferred();
    const failure = new Error("deferred callback failed");
    faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "hold",
      messageType: "result",
    });
    const delivery = await faults.apply(
      "connection-4",
      "http_sse",
      "bridge_to_gateway",
      "result",
      async () => {
        await release.promise;
        throw failure;
      },
    );

    const flush = faults.flushHeld("connection-4");
    let flushFinished = false;
    void flush.then(() => { flushFinished = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(flushFinished).toBe(false);
    expect(faults.snapshot().activeDeliveries).toBe(1);

    release.resolve();
    await expect(within(delivery.completion, "deferred failure")).resolves.toEqual({
      state: "failed",
      error: failure,
    });
    await expect(within(flush, "failed flush summary")).resolves.toEqual({
      selected: 1,
      delivered: 0,
      cancelled: 0,
      failed: 1,
    });
    expect(faults.snapshot().activeDeliveries).toBe(0);
  });

  it("rejects malformed Retry-After through the exported direct opening-fault API", () => {
    const invalid = ["", "tomorrow", "-1", "1\r\nX-Injected: yes", "1".repeat(129)];
    for (const retryAfter of invalid) {
      const faults = new FaultController();
      expect(() => faults.enqueueOpening({
        binding: "wss",
        status: 503,
        retryAfter,
      })).toThrow(/Retry-After|retryAfter/);
    }

    const faults = new FaultController();
    expect(() => faults.enqueueOpening({ binding: "wss", status: 503, retryAfter: "7" })).not.toThrow();
    expect(() => faults.enqueueOpening({
      binding: "http_sse",
      status: 503,
      retryAfter: "Wed, 22 Jul 2026 12:00:00 GMT",
    })).not.toThrow();
  });
});
