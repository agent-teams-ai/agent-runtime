export const CODEX_APP_SERVER_TIMEOUT = Symbol("codex-app-server-timeout");

export type CodexJsonRecord = Record<string, unknown>;
export type CodexReadOutcome = CodexJsonRecord | typeof CODEX_APP_SERVER_TIMEOUT | undefined;
export const CODEX_APP_SERVER_PROTOCOL_ERROR_CODE = "CODEX_APP_SERVER_PROTOCOL_ERROR" as const;

export class CodexAppServerProtocolError extends Error {
  public readonly code = CODEX_APP_SERVER_PROTOCOL_ERROR_CODE;
  public constructor(
    message: string,
    public readonly afterTurnRequest: boolean,
    public readonly explicitlyRejected = false,
  ) {
    super(message);
    this.name = "CodexAppServerProtocolError";
  }
}

export const isCodexRecord = (value: unknown): value is CodexJsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const codexStringField = (record: CodexJsonRecord, name: string): string | undefined =>
  typeof record[name] === "string" ? record[name] : undefined;

export const encodeCodexMessage = (message: CodexJsonRecord): Uint8Array =>
  Buffer.from(`${JSON.stringify(message)}\n`, "utf8");

export const codexServerRequestMethod = (message: CodexJsonRecord): string | undefined =>
  "id" in message ? codexStringField(message, "method") : undefined;

export const codexNotificationMethod = (message: CodexJsonRecord): string | undefined =>
  !(`id` in message) ? codexStringField(message, "method") : undefined;

type JsonContainer =
  | { readonly kind: "array" }
  | { readonly kind: "object"; expectingKey: boolean; readonly keys: Set<string> };

const registerDecodedPropertyName = (
  container: JsonContainer | undefined,
  source: string,
  start: number,
  end: number,
): void => {
  if (container?.kind !== "object" || !container.expectingKey || source[end] !== '"') {return;}
  let key: unknown;
  try {key = JSON.parse(source.slice(start, end + 1));} catch {return;}
  if (typeof key !== "string") {return;}
  if (container.keys.has(key)) {
    throw new Error("Codex App Server emitted duplicate decoded property names");
  }
  container.keys.add(key);
  container.expectingKey = false;
};

const assertNoDuplicateDecodedPropertyNames = (source: string): void => {
  const containers: JsonContainer[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") {index += 1; continue;}
        if (source[index] === '"') {break;}
      }
      registerDecodedPropertyName(containers.at(-1), source, start, index);
      continue;
    }
    if (character === "{") {containers.push({expectingKey: true, keys: new Set(), kind: "object"}); continue;}
    if (character === "[") {containers.push({kind: "array"}); continue;}
    if (character === "}" || character === "]") {containers.pop(); continue;}
    if (character === ",") {
      const container = containers.at(-1);
      if (container?.kind === "object") {container.expectingKey = true;}
    }
  }
};

type CodexResponseEnvelope = Readonly<
  | { readonly id: string; readonly kind: "result"; readonly result: unknown }
  | { readonly error: CodexJsonRecord; readonly id: string; readonly kind: "error" }
>;

const exactKeys = (record: CodexJsonRecord, expected: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(record, key));
};

/** App Server uses the JSON-RPC response member shapes without a `jsonrpc` member. */
export const decodeCodexResponseEnvelope = (message: CodexJsonRecord): CodexResponseEnvelope => {
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new CodexAppServerProtocolError("Codex App Server response identity is malformed", false);
  }
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError) {
    throw new CodexAppServerProtocolError("Codex App Server response result shape is malformed", false);
  }
  if (hasResult) {
    if (!exactKeys(message, ["id", "result"])) {
      throw new CodexAppServerProtocolError("Codex App Server response envelope is malformed", false);
    }
    return Object.freeze({id: message.id, kind: "result", result: message.result});
  }
  if (!exactKeys(message, ["error", "id"]) || !isCodexRecord(message.error)
    || !exactKeys(message.error, Object.hasOwn(message.error, "data")
      ? ["code", "data", "message"] : ["code", "message"])
    || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string") {
    throw new CodexAppServerProtocolError("Codex App Server error response is malformed", false);
  }
  return Object.freeze({error: message.error, id: message.id, kind: "error"});
};

export const codexResponseResult = (
  message: CodexJsonRecord,
  requestId: string,
): unknown | typeof CODEX_APP_SERVER_TIMEOUT => {
  const response = decodeCodexResponseEnvelope(message);
  if (response.id !== requestId) {return CODEX_APP_SERVER_TIMEOUT;}
  if (response.kind === "error") {
    throw new CodexAppServerProtocolError("Codex App Server request was rejected", false, true);
  }
  return response.result;
};

export class BoundedCodexJsonLineReader {
  static readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #maxLineBytes: number;
  #chunk: Buffer | undefined;
  #chunkOffset = 0;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #ended = false;
  #pending: Promise<IteratorResult<Uint8Array>> | undefined;

  public constructor(source: AsyncIterable<Uint8Array>, maxLineBytes: number) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#maxLineBytes = maxLineBytes;
  }

  async #nextChunk(deadline: number): Promise<IteratorResult<Uint8Array> | typeof CODEX_APP_SERVER_TIMEOUT> {
    this.#pending ??= this.#iterator.next();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {return CODEX_APP_SERVER_TIMEOUT;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof CODEX_APP_SERVER_TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(CODEX_APP_SERVER_TIMEOUT), remaining);
    });
    const result = await Promise.race([this.#pending, timeout]);
    if (timer !== undefined) {clearTimeout(timer);}
    if (result !== CODEX_APP_SERVER_TIMEOUT) {this.#pending = undefined;}
    return result;
  }

  #appendFragment(fragment: Buffer): void {
    if (fragment.length === 0) {return;}
    this.#fragmentBytes += fragment.length;
    if (this.#fragmentBytes > this.#maxLineBytes) {
      throw new Error("Codex App Server line exceeds the configured bound");
    }
    this.#fragments.push(fragment);
  }

  #completeLine(fragment: Buffer): Buffer {
    const lineBytes = this.#fragmentBytes + fragment.length;
    if (lineBytes > this.#maxLineBytes) {
      throw new Error("Codex App Server line exceeds the configured bound");
    }
    let line: Buffer;
    if (this.#fragments.length === 0) {
      line = fragment;
    } else {
      if (fragment.length > 0) {this.#fragments.push(fragment);}
      line = Buffer.concat(this.#fragments, lineBytes);
    }
    this.#fragments = [];
    this.#fragmentBytes = 0;
    return line;
  }

  #takeLineFromChunk(): Buffer | undefined {
    if (this.#chunk === undefined) {return undefined;}
    const newline = this.#chunk.indexOf(0x0a, this.#chunkOffset);
    if (newline < 0) {
      this.#appendFragment(this.#chunk.subarray(this.#chunkOffset));
      this.#chunk = undefined;
      this.#chunkOffset = 0;
      return undefined;
    }
    const line = this.#completeLine(this.#chunk.subarray(this.#chunkOffset, newline));
    this.#chunkOffset = newline + 1;
    if (this.#chunkOffset === this.#chunk.length) {
      this.#chunk = undefined;
      this.#chunkOffset = 0;
    }
    return line;
  }

  #decodeLine(line: Buffer): CodexJsonRecord | undefined {
    const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (normalized.length === 0) {return undefined;}
    let decoded: unknown;
    try {
      const source = BoundedCodexJsonLineReader.#decoder.decode(normalized);
      assertNoDuplicateDecodedPropertyNames(source);
      decoded = JSON.parse(source);
    } catch {
      throw new Error("Codex App Server emitted invalid UTF-8 or malformed JSON");
    }
    if (!isCodexRecord(decoded)) {throw new Error("Codex App Server message must be an object");}
    return decoded;
  }

  public async read(deadline: number): Promise<CodexReadOutcome> {
    while (true) {
      const line = this.#takeLineFromChunk();
      if (line !== undefined) {
        const decoded = this.#decodeLine(line);
        if (decoded !== undefined) {return decoded;}
        continue;
      }
      if (this.#ended) {
        if (this.#fragmentBytes !== 0) {throw new Error("Codex App Server closed with an unterminated message");}
        return undefined;
      }
      const next = await this.#nextChunk(deadline);
      if (next === CODEX_APP_SERVER_TIMEOUT) {return CODEX_APP_SERVER_TIMEOUT;}
      if (next.done) {
        this.#ended = true;
      } else {
        this.#chunk = Buffer.from(next.value);
        this.#chunkOffset = 0;
      }
    }
  }
}
