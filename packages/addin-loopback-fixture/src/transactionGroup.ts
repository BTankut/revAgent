import type { JsonValue } from "./types.js";

export type TransactionGroupState =
  | "not_started"
  | "started"
  | "assimilated"
  | "rolled_back"
  | "rollback_failed";

interface StagedMutation {
  readonly key: string;
  readonly value: JsonValue;
}

/**
 * A deterministic in-memory model of Revit's TransactionGroup semantics.
 * It is intentionally not a Revit API substitute: it makes atomicity observable
 * in Linux CI while keeping all writes staged until Assimilate.
 */
export class TestTransactionGroup {
  readonly #model: Map<string, JsonValue>;
  readonly #staged: StagedMutation[] = [];
  readonly #failRollback: boolean;
  #state: TransactionGroupState = "not_started";

  public constructor(model: Map<string, JsonValue>, failRollback = false) {
    this.#model = model;
    this.#failRollback = failRollback;
  }

  public get state(): TransactionGroupState {
    return this.#state;
  }

  public get stagedMutationCount(): number {
    return this.#staged.length;
  }

  public start(): void {
    if (this.#state !== "not_started") {
      throw new Error(`TransactionGroup cannot start from ${this.#state}`);
    }
    this.#state = "started";
  }

  public stage(key: string, value: JsonValue): void {
    if (this.#state !== "started") {
      throw new Error("Mutation requires a started TransactionGroup");
    }
    if (key.length === 0) {
      throw new Error("Mutation key must not be empty");
    }
    this.#staged.push({ key, value: structuredClone(value) });
  }

  public read(key: string): JsonValue | undefined {
    for (let index = this.#staged.length - 1; index >= 0; index -= 1) {
      const mutation = this.#staged[index];
      if (mutation?.key === key) return structuredClone(mutation.value);
    }
    const value = this.#model.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  public assimilate(): void {
    if (this.#state !== "started") {
      throw new Error(`TransactionGroup cannot assimilate from ${this.#state}`);
    }
    for (const mutation of this.#staged) {
      this.#model.set(mutation.key, structuredClone(mutation.value));
    }
    this.#staged.length = 0;
    this.#state = "assimilated";
  }

  public rollback(): void {
    if (this.#state !== "started") {
      throw new Error(`TransactionGroup cannot roll back from ${this.#state}`);
    }
    if (this.#failRollback) {
      this.#state = "rollback_failed";
      throw new Error("Injected TransactionGroup rollback failure");
    }
    this.#staged.length = 0;
    this.#state = "rolled_back";
  }
}
