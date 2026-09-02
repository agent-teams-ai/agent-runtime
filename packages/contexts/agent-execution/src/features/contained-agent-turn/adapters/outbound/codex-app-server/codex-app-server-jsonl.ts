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

export const codexResponseResult = (
  message: CodexJsonRecord,
  requestId: string,
): unknown | typeof CODEX_APP_SERVER_TIMEOUT => {
  if (message.id !== requestId) {return CODEX_APP_SERVER_TIMEOUT;}
  if (isCodexRecord(message.error)) {
    throw new CodexAppServerProtocolError("Codex App Server request was rejected", false, true);
  }
  if (!("result" in message)) {throw new Error("Codex App Server response has no result");}
  return message.result;
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
      decoded = JSON.parse(BoundedCodexJsonLineReader.#decoder.decode(normalized));
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
