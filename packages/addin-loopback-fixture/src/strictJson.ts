export const DEFAULT_STRICT_JSON_MAX_BYTES = 64 * 1024;

export type StrictJsonErrorCode =
  | "too_large"
  | "utf8_bom"
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_key";

export class StrictJsonError extends Error {
  public readonly code: StrictJsonErrorCode;
  public readonly duplicateKey: string | null;
  public readonly actualBytes: number | null;
  public readonly maxBytes: number | null;

  public constructor(
    code: StrictJsonErrorCode,
    message: string,
    options: {
      duplicateKey?: string;
      actualBytes?: number;
      maxBytes?: number;
    } = {},
  ) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.duplicateKey = options.duplicateKey ?? null;
    this.actualBytes = options.actualBytes ?? null;
    this.maxBytes = options.maxBytes ?? null;
  }
}

class DuplicateKeyError extends Error {
  public constructor(public readonly key: string) {
    super(`duplicate JSON object key: ${key}`);
    this.name = "DuplicateKeyError";
  }
}

class DuplicateKeyScanner {
  #index = 0;

  public constructor(private readonly text: string) {}

  public scan(): void {
    this.#skipWhitespace();
    this.#scanValue();
    this.#skipWhitespace();
    if (this.#index !== this.text.length) throw new Error("unexpected trailing JSON text");
  }

  #scanValue(): void {
    const character = this.text[this.#index];
    if (character === "{") {
      this.#scanObject();
      return;
    }
    if (character === "[") {
      this.#scanArray();
      return;
    }
    if (character === '"') {
      this.#scanString();
      return;
    }
    while (
      this.#index < this.text.length &&
      !/[\s,}\]]/u.test(this.text[this.#index] ?? "")
    ) {
      this.#index += 1;
    }
  }

  #scanObject(): void {
    this.#index += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    while (this.#index < this.text.length) {
      const key = this.#scanString();
      if (keys.has(key)) throw new DuplicateKeyError(key);
      keys.add(key);
      this.#skipWhitespace();
      if (this.text[this.#index] !== ":") throw new Error("expected JSON object colon");
      this.#index += 1;
      this.#skipWhitespace();
      this.#scanValue();
      this.#skipWhitespace();
      if (this.text[this.#index] === "}") {
        this.#index += 1;
        return;
      }
      if (this.text[this.#index] !== ",") throw new Error("expected JSON object separator");
      this.#index += 1;
      this.#skipWhitespace();
    }
    throw new Error("unterminated JSON object");
  }

  #scanArray(): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (this.#index < this.text.length) {
      this.#scanValue();
      this.#skipWhitespace();
      if (this.text[this.#index] === "]") {
        this.#index += 1;
        return;
      }
      if (this.text[this.#index] !== ",") throw new Error("expected JSON array separator");
      this.#index += 1;
      this.#skipWhitespace();
    }
    throw new Error("unterminated JSON array");
  }

  #scanString(): string {
    if (this.text[this.#index] !== '"') throw new Error("expected JSON string");
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      if (character === '"') {
        this.#index += 1;
        return JSON.parse(this.text.slice(start, this.#index)) as string;
      }
      this.#index += character === "\\" ? 2 : 1;
    }
    throw new Error("unterminated JSON string");
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.text[this.#index] ?? "")) this.#index += 1;
  }
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function parseStrictJsonBytes(
  bytes: Uint8Array,
  maxBytes = DEFAULT_STRICT_JSON_MAX_BYTES,
): unknown {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (bytes.byteLength > maxBytes) {
    throw new StrictJsonError(
      "too_large",
      `JSON value is ${bytes.byteLength} bytes; maximum is ${maxBytes}`,
      { actualBytes: bytes.byteLength, maxBytes },
    );
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError("utf8_bom", "JSON must be UTF-8 without BOM");
  }

  let text: string;
  try {
    text = fatalUtf8Decoder.decode(bytes);
  } catch {
    throw new StrictJsonError("invalid_utf8", "JSON is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new StrictJsonError("invalid_json", "JSON text is invalid");
  }
  try {
    new DuplicateKeyScanner(text).scan();
  } catch (error) {
    if (error instanceof DuplicateKeyError) {
      throw new StrictJsonError("duplicate_key", error.message, { duplicateKey: error.key });
    }
    throw new StrictJsonError("invalid_json", "JSON text is invalid");
  }
  return value;
}
