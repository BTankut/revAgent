import { describe, expect, it } from "vitest";
import { z } from "zod";

import { gatewayExternalToolInputJsonSchema } from "./confirmation.js";
import {
  ModeADiscoverySession,
  ModeASchemaBudgetError,
  ModeAToolUnavailableError,
} from "./modeADiscovery.js";
import {
  GatewayToolRegistry,
  type GatewayJsonSchema,
  type GatewayToolRecord,
} from "./registry.js";

function tool(
  name: string,
  summary: string,
  argumentName = "target",
  argumentDescription = "Shared target argument.",
): GatewayToolRecord {
  return {
    name,
    summary,
    namespace: name.split(".", 1)[0]!,
    version: "1.0.0",
    policyClass: "auto",
    mutationScopePolicy: "none",
    executor: "bridge",
    executorMethod: name.replaceAll(".", "_"),
    inputSchema: {
      [argumentName]: z.string().describe(argumentDescription),
    },
    inputJsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        [argumentName]: {
          description: argumentDescription,
          type: "string",
        },
      },
      required: [argumentName],
      type: "object",
    },
  };
}

function bytes(schema: GatewayJsonSchema): number {
  return Buffer.byteLength(JSON.stringify(schema), "utf8");
}

describe("ModeADiscoverySession", () => {
  it("searches visible names, summaries, and argument metadata deterministically", () => {
    const records = [
      tool(
        "zeta.element.read",
        "Read a shared model item.",
        "elementId",
        "Stable element identifier.",
      ),
      tool(
        "alpha.element.read",
        "Read a shared model item.",
        "elementId",
        "Stable element identifier.",
      ),
      tool(
        "docs.type.details",
        "Read API metadata.",
        "symbolName",
        "Fully qualified element symbol.",
      ),
    ] as const;
    const forwardRegistry = new GatewayToolRegistry(records);
    const reverseRegistry = new GatewayToolRegistry([...records].reverse());
    const forward = new ModeADiscoverySession(
      forwardRegistry.fullView(),
      [],
      10_000,
    );
    const reverse = new ModeADiscoverySession(
      reverseRegistry.fullView(),
      [],
      10_000,
    );

    expect(forward.search("element").map(({ name }) => name)).toEqual([
      "alpha.element.read",
      "zeta.element.read",
      "docs.type.details",
    ]);
    expect(forward.search("element")).toEqual(reverse.search("element"));
    expect(forward.search("symbolName").map(({ name }) => name)).toEqual([
      "docs.type.details",
    ]);
    expect(forward.search("qualified symbol").map(({ name }) => name)).toEqual([
      "docs.type.details",
    ]);
  });

  it("keeps activation session-local and pinned tools outside the budget", () => {
    const pinned = tool("core.session.status", "Read session status.");
    const deferred = tool("core.element.query", "Query model elements.");
    const registry = new GatewayToolRegistry([pinned, deferred]);
    const first = new ModeADiscoverySession(
      registry.fullView(),
      [pinned.name],
      bytes(deferred.inputJsonSchema),
    );
    const second = new ModeADiscoverySession(
      registry.fullView(),
      [pinned.name],
      bytes(deferred.inputJsonSchema),
    );

    expect(first.isCallable(pinned.name)).toBe(true);
    expect(first.activeSchemaBytes()).toBe(0);
    expect(first.activate([pinned.name]).schemas).toEqual([
      { name: pinned.name, inputSchema: pinned.inputJsonSchema },
    ]);
    first.activate([deferred.name]);

    expect(first.isCallable(deferred.name)).toBe(true);
    expect(second.isCallable(deferred.name)).toBe(false);
    expect(second.activeNames()).toEqual([]);
  });

  it("evicts least-recent schemas while retaining every requested activation", () => {
    const alpha = tool("core.alpha.read", "Read alpha.");
    const bravo = tool("core.bravo.read", "Read bravo.");
    const charlie = tool("core.charlie.read", "Read charlie.");
    const registry = new GatewayToolRegistry([alpha, bravo, charlie]);
    const twoSchemaBudget =
      bytes(alpha.inputJsonSchema) + bytes(bravo.inputJsonSchema);
    const session = new ModeADiscoverySession(
      registry.fullView(),
      [],
      twoSchemaBudget,
    );

    session.activate([alpha.name, bravo.name]);
    session.activate([alpha.name]);
    const result = session.activate([charlie.name]);

    expect(result.evictedNames).toEqual([bravo.name]);
    expect(session.activeNames()).toEqual([alpha.name, charlie.name]);

    session.requireCallable(alpha.name);
    const replacement = session.activate([bravo.name]);
    expect(replacement.evictedNames).toEqual([charlie.name]);
    expect(session.activeNames()).toEqual([alpha.name, bravo.name]);
  });

  it("rejects an oversized activation transaction without partial changes", () => {
    const alpha = tool("core.alpha.read", "Read alpha.");
    const bravo = tool("core.bravo.read", "Read bravo.");
    const charlie = tool("core.charlie.read", "Read charlie.");
    const registry = new GatewayToolRegistry([alpha, bravo, charlie]);
    const session = new ModeADiscoverySession(
      registry.fullView(),
      [],
      bytes(alpha.inputJsonSchema) + bytes(bravo.inputJsonSchema),
    );
    session.activate([alpha.name]);
    const before = session.activeNames();

    expect(() =>
      session.activate([alpha.name, bravo.name, charlie.name]),
    ).toThrow(ModeASchemaBudgetError);
    expect(session.activeNames()).toEqual(before);
    expect(session.isCallable(bravo.name)).toBe(false);
    expect(session.isCallable(charlie.name)).toBe(false);
  });

  it("makes unknown and unentitled tools indistinguishable", () => {
    const visible = tool("core.visible.read", "Read visible state.");
    const hidden = tool("core.hidden.read", "Read secret state.");
    const registry = new GatewayToolRegistry([visible, hidden]);
    const session = new ModeADiscoverySession(
      registry.view([visible.name]),
      [hidden.name],
      bytes(visible.inputJsonSchema),
    );

    expect(session.search("secret")).toEqual([]);
    expect(session.isCallable(hidden.name)).toBe(false);
    const hiddenError = expectUnavailable(() =>
      session.activate([hidden.name]),
    );
    const unknownError = expectUnavailable(() =>
      session.activate(["core.missing.read"]),
    );
    expect(hiddenError).toEqual(unknownError);

    expect(() => session.activate([visible.name, hidden.name])).toThrow(
      ModeAToolUnavailableError,
    );
    expect(session.activeNames()).toEqual([]);
    expectUnavailable(() => session.requireCallable(visible.name));
    expectUnavailable(() => session.requireCallable(hidden.name));
  });

  it("budgets and returns the north-equivalent confirmation schema without indexing control fields", () => {
    const confirm: GatewayToolRecord = {
      ...tool("core.parameter.set", "Set one exact parameter."),
      policyClass: "confirm",
      mutationScopePolicy: "session",
      executorMethod: "set_element_parameter",
    };
    const externalSchema = gatewayExternalToolInputJsonSchema(confirm);
    const registry = new GatewayToolRegistry([confirm]);
    const session = new ModeADiscoverySession(
      registry.fullView(),
      [],
      bytes(externalSchema),
    );

    expect(session.search("confirm_token")).toEqual([]);
    expect(session.search("originating_preview_invocation_id")).toEqual([]);
    expect(session.search("target").map(({ name }) => name)).toEqual([
      confirm.name,
    ]);
    const activated = session.activate([confirm.name]);
    expect(activated.schemas).toEqual([
      { name: confirm.name, inputSchema: externalSchema },
    ]);
    expect(activated.activeSchemaBytes).toBe(bytes(externalSchema));
  });
});

function expectUnavailable(action: () => unknown): {
  readonly code: string;
  readonly message: string;
} {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ModeAToolUnavailableError);
    const unavailable = error as ModeAToolUnavailableError;
    return { code: unavailable.code, message: unavailable.message };
  }
  throw new Error("expected ModeAToolUnavailableError");
}
