export const CODEX_APP_SERVER_TIMEOUT = Symbol("codex-app-server-timeout");

export type CodexJsonRecord = Record<string, unknown>;
export type CodexReadOutcome = CodexJsonRecord | typeof CODEX_APP_SERVER_TIMEOUT | undefined;

export class CodexAppServerProtocolError extends Error {
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

export const codexResponseResult = (
  message: CodexJsonRecord,
  requestId: string,
): unknown | typeof CODEX_APP_SERVER_TIMEOUT => {
  if (message.id !== requestId) {return CODEX_APP_SERVER_TIMEOUT;}
  if (isCodexRecord(message.error)) {
    const detail = codexStringField(message.error, "message") ?? "unknown JSON-RPC error";
    throw new CodexAppServerProtocolError(`Codex App Server rejected a request: ${detail}`, false, true);
  }
  if (!("result" in message)) {throw new Error("Codex App Server response has no result");}
  return message.result;
};

export class BoundedCodexJsonLineReader {
  static readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #maxLineBytes: number;
  #buffer = Buffer.alloc(0);
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

  public async read(deadline: number): Promise<CodexReadOutcome> {
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > this.#maxLineBytes) {throw new Error("Codex App Server line exceeds the configured bound");}
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
        if (normalized.length === 0) {continue;}
        let decoded: unknown;
        try {
          decoded = JSON.parse(BoundedCodexJsonLineReader.#decoder.decode(normalized));
        } catch {
          throw new Error("Codex App Server emitted invalid UTF-8 or malformed JSON");
        }
        if (!isCodexRecord(decoded)) {throw new Error("Codex App Server message must be an object");}
        return decoded;
      }
      if (this.#buffer.length > this.#maxLineBytes) {throw new Error("Codex App Server line exceeds the configured bound");}
      if (this.#ended) {
        if (this.#buffer.length !== 0) {throw new Error("Codex App Server closed with an unterminated message");}
        return undefined;
      }
      const next = await this.#nextChunk(deadline);
      if (next === CODEX_APP_SERVER_TIMEOUT) {return CODEX_APP_SERVER_TIMEOUT;}
      if (next.done) {
        this.#ended = true;
      } else {
        const bytes = Buffer.from(next.value);
        if (this.#buffer.length + bytes.length > this.#maxLineBytes + 1) {
          throw new Error("Codex App Server input buffer exceeds the configured bound");
        }
        this.#buffer = Buffer.concat([this.#buffer, bytes]);
      }
    }
  }
}
