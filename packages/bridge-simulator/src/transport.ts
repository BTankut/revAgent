import { isIP } from "node:net";

import {
  rbpEnvelopeErrors,
  validateRbpEnvelope,
  type HelloAckEnvelope,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import WebSocket from "ws";

export type BridgeBindingKind = "wss" | "streamable_http_sse";

export interface GatewayBinding {
  readonly kind: BridgeBindingKind;
  readonly connectionId: string | null;
  readonly bufferedAmount: number;
  open(hello: HelloEnvelope): Promise<HelloAckEnvelope>;
  send(envelope: RbpEnvelope): Promise<void>;
  messages(): AsyncIterable<RbpEnvelope>;
  close(): Promise<void>;
}

export interface BindingOptions {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly versionsHeader?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Test-adapter seam; production callers leave this unset. */
  readonly webSocketFactory?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
}

interface QueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void;
  readonly reject: (error: Error) => void;
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #closed = false;
  #error: Error | null = null;

  public push(item: T): void {
    if (this.#closed) throw new Error("message queue is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter.resolve({ done: false, value: item });
  }

  public close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error === null) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(this.#error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.#closed) {
          if (this.#error !== null) throw this.#error;
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function assertGatewayUrl(value: string, requiredProtocol: "https:" | "wss:"): URL {
  const url = new URL(value);
  if (url.protocol !== requiredProtocol) {
    throw new Error(`Gateway ${requiredProtocol} URL required`);
  }
  if (isIP(url.hostname) !== 0 || url.hostname.length === 0 || url.username || url.password) {
    throw new Error("Gateway URL must use an authenticated DNS name without userinfo");
  }
  if (url.search || url.hash) throw new Error("Gateway base URL cannot contain query or fragment");
  return url;
}

function assertPreNegotiationEnvelope(envelope: HelloEnvelope | HelloAckEnvelope): void {
  const envelopeType = envelope.type;
  if (Object.hasOwn(envelope, "v") || Object.hasOwn(envelope, "rsid") || Object.hasOwn(envelope, "seq")) {
    throw new Error(`${envelope.type} must omit v/rsid/seq before negotiation`);
  }
  if (!validateRbpEnvelope(envelope)) {
    throw new Error(`${envelopeType} failed RBP validation: ${JSON.stringify(rbpEnvelopeErrors())}`);
  }
}

function parseEnvelope(text: string): RbpEnvelope {
  const value: unknown = JSON.parse(text);
  if (!validateRbpEnvelope(value)) {
    throw new Error(`Gateway envelope failed validation: ${JSON.stringify(rbpEnvelopeErrors())}`);
  }
  return value;
}

function helloAck(value: RbpEnvelope, expectedConnectionId?: string): HelloAckEnvelope {
  if (value.type !== "hello_ack") throw new Error("Gateway first response must be hello_ack");
  assertPreNegotiationEnvelope(value);
  if (
    expectedConnectionId !== undefined &&
    value.payload.connection_id !== expectedConnectionId
  ) {
    throw new Error("hello_ack connection id does not match transport binding");
  }
  return value;
}

function authHeaders(options: BindingOptions): Record<string, string> {
  if (options.deviceToken.length < 1 || /[\r\n]/u.test(options.deviceToken)) {
    throw new Error("device token is required and cannot contain line breaks");
  }
  return {
    Authorization: `Bearer ${options.deviceToken}`,
    "X-RBP-Versions": options.versionsHeader ?? "1",
  };
}

export function gatewayCompatibilityWindow(currentProtocol: number): readonly number[] {
  if (!Number.isSafeInteger(currentProtocol) || currentProtocol < 1) {
    throw new RangeError("current protocol must be a positive safe integer");
  }
  return currentProtocol === 1 ? [1] : [currentProtocol, currentProtocol - 1];
}

export function selectHighestCompatibleProtocol(input: {
  readonly bridgeMin: number;
  readonly bridgeMax: number;
  readonly gatewayCurrent: number;
}): number | null {
  if (
    !Number.isSafeInteger(input.bridgeMin) ||
    !Number.isSafeInteger(input.bridgeMax) ||
    input.bridgeMin < 1 ||
    input.bridgeMax < input.bridgeMin
  ) {
    throw new RangeError("invalid bridge protocol interval");
  }
  return (
    gatewayCompatibilityWindow(input.gatewayCurrent).find(
      (version) => version >= input.bridgeMin && version <= input.bridgeMax,
    ) ?? null
  );
}

export class WssGatewayBinding implements GatewayBinding {
  readonly #options: BindingOptions;
  readonly #queue = new AsyncMessageQueue<RbpEnvelope>();
  #socket: WebSocket | null = null;
  #connectionId: string | null = null;

  public constructor(options: BindingOptions) {
    this.#options = options;
    const url = assertGatewayUrl(options.baseUrl, "wss:");
    if (url.pathname !== "/bridge/v1" && url.pathname !== "/bridge/v1/") {
      throw new Error("WSS binding path must be /bridge/v1");
    }
  }

  public get kind(): "wss" {
    return "wss";
  }

  public get connectionId(): string | null {
    return this.#connectionId;
  }

  public get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  public async open(hello: HelloEnvelope): Promise<HelloAckEnvelope> {
    if (this.#socket !== null) throw new Error("WSS binding already opened");
    assertPreNegotiationEnvelope(hello);
    const socket = (this.#options.webSocketFactory ?? ((url, options) => new WebSocket(url, options)))(
      this.#options.baseUrl,
      { headers: authHeaders(this.#options) },
    );
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off("open", onOpen);
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    const first = new Promise<HelloAckEnvelope>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData, binary: boolean): void => {
        cleanup();
        try {
          if (binary) throw new Error("RBP WSS requires text frames");
          const ack = helloAck(parseEnvelope(data.toString()));
          this.#connectionId = ack.payload.connection_id;
          resolve(ack);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("WSS closed before hello_ack"));
      };
      const cleanup = (): void => {
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };
      socket.once("message", onMessage);
      socket.once("close", onClose);
    });
    socket.send(JSON.stringify(hello));
    const ack = await first;
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("RBP WSS requires text frames");
        this.#queue.push(parseEnvelope(data.toString()));
      } catch (error) {
        this.#queue.close(error instanceof Error ? error : new Error(String(error)));
        socket.close(4400, "protocol error");
      }
    });
    socket.on("close", () => this.#queue.close());
    socket.on("error", (error) => this.#queue.close(error));
    return ack;
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#connectionId === null) {
      throw new Error("WSS binding is not steady");
    }
    if (!validateRbpEnvelope(envelope)) throw new Error("invalid outbound RBP envelope");
    await new Promise<void>((resolve, reject) => {
      this.#socket?.send(JSON.stringify(envelope), (error) => (error ? reject(error) : resolve()));
    });
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    return this.#queue;
  }

  public async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#connectionId = null;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off("close", finish);
        socket.off("error", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        finish();
      }, 1_000);
      socket.once("close", finish);
      socket.once("error", finish);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge simulator close");
    });
  }
}

function oneLineSseData(line: string): RbpEnvelope {
  if (line.includes("\r") || line.includes("\n")) throw new Error("SSE RBP data must be one line");
  return parseEnvelope(line);
}

export class HttpSseGatewayBinding implements GatewayBinding {
  readonly #options: BindingOptions;
  readonly #base: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #queue = new AsyncMessageQueue<RbpEnvelope>();
  #connectionId: string | null = null;
  #abort: AbortController | null = null;
  #unacceptedBytes = 0;

  public constructor(options: BindingOptions) {
    this.#options = options;
    this.#base = assertGatewayUrl(options.baseUrl, "https:");
    if (this.#base.pathname !== "/" && this.#base.pathname !== "") {
      throw new Error("HTTP/SSE binding base URL must not contain a path");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public get kind(): "streamable_http_sse" {
    return "streamable_http_sse";
  }

  public get connectionId(): string | null {
    return this.#connectionId;
  }

  public get bufferedAmount(): number {
    return this.#unacceptedBytes;
  }

  public async open(hello: HelloEnvelope): Promise<HelloAckEnvelope> {
    if (this.#connectionId !== null) throw new Error("HTTP/SSE binding already opened");
    assertPreNegotiationEnvelope(hello);
    const headers = authHeaders(this.#options);
    const createUrl = new URL("/bridge/v1/http/connections", this.#base);
    const response = await this.#fetch(createUrl, {
      method: "POST",
      headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(hello),
      redirect: "error",
    });
    if (response.status !== 201) throw new Error(`fallback create expected 201, got ${response.status}`);
    const connectionId = response.headers.get("RBP-Connection-Id");
    if (connectionId === null || connectionId.length === 0 || /[\r\n/]/u.test(connectionId)) {
      throw new Error("fallback create omitted a valid RBP-Connection-Id");
    }
    const ack = helloAck(parseEnvelope(await response.text()), connectionId);

    const abort = new AbortController();
    const eventsUrl = new URL(
      `/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`,
      this.#base,
    );
    const events = await this.#fetch(eventsUrl, {
      method: "GET",
      headers: { ...headers, Accept: "text/event-stream" },
      redirect: "error",
      signal: abort.signal,
    });
    if (events.status !== 200 || !events.body) {
      abort.abort();
      throw new Error(`fallback events expected streaming 200, got ${events.status}`);
    }
    const contentType = events.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/event-stream") {
      abort.abort();
      throw new Error("fallback events response is not text/event-stream");
    }
    this.#connectionId = connectionId;
    this.#abort = abort;
    void this.#consumeEvents(events.body, abort.signal);
    return ack;
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    const connectionId = this.#connectionId;
    if (connectionId === null) throw new Error("HTTP/SSE binding is not steady");
    if (!validateRbpEnvelope(envelope)) throw new Error("invalid outbound RBP envelope");
    const body = JSON.stringify(envelope);
    this.#unacceptedBytes += Buffer.byteLength(body, "utf8");
    try {
      const response = await this.#fetch(
        new URL(`/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`, this.#base),
        {
          method: "POST",
          headers: {
            ...authHeaders(this.#options),
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body,
          redirect: "error",
        },
      );
      if (response.status !== 202) {
        throw new Error(`fallback message expected 202, got ${response.status}`);
      }
    } finally {
      this.#unacceptedBytes -= Buffer.byteLength(body, "utf8");
    }
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    return this.#queue;
  }

  public async close(): Promise<void> {
    this.#abort?.abort();
    this.#abort = null;
    this.#connectionId = null;
    this.#queue.close();
  }

  async #consumeEvents(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader();
    const cancelReader = (): void => {
      void reader.cancel("HTTP/SSE binding closed");
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let eventName = "";
    let data: string[] = [];
    const dispatch = (): void => {
      if (eventName === "" && data.length === 0) return;
      if (eventName !== "rbp" || data.length !== 1) {
        throw new Error("fallback SSE event must be exactly event: rbp plus one data line");
      }
      this.#queue.push(oneLineSseData(data[0] as string));
      eventName = "";
      data = [];
    };
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          let line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            dispatch();
          } else if (line.startsWith(":")) {
            continue;
          } else if (line.startsWith("event:")) {
            eventName = line.slice(6).trimStart();
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
          }
        }
      }
      if (!signal.aborted) this.#queue.close(new Error("fallback SSE stream ended"));
    } catch (error) {
      if (!signal.aborted) this.#queue.close(error instanceof Error ? error : new Error(String(error)));
    } finally {
      signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
  }
}

export async function openPrimaryThenFallback(input: {
  readonly hello: HelloEnvelope;
  readonly wss: GatewayBinding;
  readonly fallback?: GatewayBinding;
  readonly fallbackProvisioned: boolean;
  readonly classifyWssFailure: (error: unknown) =>
    | "retryable_network"
    | "auth"
    | "version"
    | "trust"
    | "protocol";
}): Promise<{ readonly binding: GatewayBinding; readonly helloAck: HelloAckEnvelope }> {
  try {
    return { binding: input.wss, helloAck: await input.wss.open(input.hello) };
  } catch (error) {
    try {
      await input.wss.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "failed WSS primary could not be closed before transport selection",
      );
    }
    const failure = input.classifyWssFailure(error);
    if (!input.fallbackProvisioned || input.fallback === undefined || failure !== "retryable_network") {
      throw error;
    }
    return { binding: input.fallback, helloAck: await input.fallback.open(input.hello) };
  }
}
