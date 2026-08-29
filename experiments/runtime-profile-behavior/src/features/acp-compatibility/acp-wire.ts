export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type AcpWireErrorCode =
  | "connection_closed"
  | "process_exit"
  | "request_timeout"
  | "write_failed";

export class AcpWireTransportError extends Error {
  public readonly code: AcpWireErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: AcpWireErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AcpWireTransportError";
    this.code = code;
    this.details = details;
  }
}

export type AcpProtocolErrorCode =
  | "duplicate_response"
  | "invalid_message"
  | "late_response"
  | "malformed_json"
  | "remote_error"
  | "unsupported_protocol";

export class AcpWireProtocolError extends Error {
  public readonly code: AcpProtocolErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: AcpProtocolErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AcpWireProtocolError";
    this.code = code;
    this.details = details;
  }
}

export interface AcpWireScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const systemScheduler: AcpWireScheduler = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingRequest {
  readonly method: string;
  readonly timer: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

export interface AcpWireClientOptions {
  readonly requestTimeoutMs: number;
  readonly write: (line: string) => void | Promise<void>;
  readonly onNotification?: (message: JsonRpcNotification) => void;
  readonly onProtocolError?: (error: AcpWireProtocolError) => void;
  readonly onRequest?: (request: JsonRpcRequest) => unknown | Promise<unknown>;
  readonly scheduler?: AcpWireScheduler;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isSafeInteger(value));

/** Provider-neutral newline-delimited JSON-RPC/ACP stdio anti-corruption seam. */
export class AcpWireClient {
  readonly #responded = new Set<JsonRpcId>();
  readonly #options: AcpWireClientOptions;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #scheduler: AcpWireScheduler;
  #buffer = "";
  #closed = false;
  #nextId = 1;

  public constructor(options: AcpWireClientOptions) {
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer");
    }
    this.#options = options;
    this.#scheduler = options.scheduler ?? systemScheduler;
  }

  public request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new AcpWireTransportError("connection_closed", "ACP connection is closed"),
      );
    }
    const id = this.#nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = this.#scheduler.set(this.#options.requestTimeoutMs, () => {
        if (!this.#pending.delete(id)) return;
        reject(
          new AcpWireTransportError(
            "request_timeout",
            `ACP request ${method} timed out after ${this.#options.requestTimeoutMs}ms`,
            { id, method, timeoutMs: this.#options.requestTimeoutMs },
          ),
        );
      });
      this.#pending.set(id, { method, timer, resolve, reject });
      Promise.resolve(this.#options.write(`${JSON.stringify(message)}\n`)).catch((cause: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        this.#scheduler.clear(pending.timer);
        pending.reject(
          new AcpWireTransportError("write_failed", `Failed to write ACP request ${method}`, {
            cause: cause instanceof Error ? cause.message : String(cause),
            id,
            method,
          }),
        );
      });
    });
  }

  public receive(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#receiveLine(line);
    }
  }

  public close(): void {
    this.#failPending(new AcpWireTransportError("connection_closed", "ACP connection closed"));
  }

  public processExited(exitCode: number | null, signal: string | null): void {
    this.#failPending(
      new AcpWireTransportError("process_exit", "ACP process exited", { exitCode, signal }),
    );
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (this.#options.onRequest === undefined) {
        await this.#options.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not supported" } })}\n`,
        );
        return;
      }
      const result = await this.#options.onRequest(request);
      await this.#options.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (cause) {
      await this.#options.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: cause instanceof Error ? cause.message : "Callback failed" } })}\n`,
      );
    }
  }

  #receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#report(new AcpWireProtocolError("malformed_json", "Malformed ACP JSON line", { line }));
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.#report(new AcpWireProtocolError("invalid_message", "Invalid ACP JSON-RPC message", { message }));
      return;
    }
    if (typeof message.method === "string") {
      if (validId(message.id)) {
        void this.#handleRequest(message as unknown as JsonRpcRequest);
      } else if (message.id === undefined) {
        this.#options.onNotification?.(message as unknown as JsonRpcNotification);
      } else {
        this.#report(new AcpWireProtocolError("invalid_message", "ACP request has invalid id", { message }));
      }
      return;
    }
    if (!validId(message.id) || (message.result === undefined) === (message.error === undefined)) {
      this.#report(new AcpWireProtocolError("invalid_message", "Invalid ACP response envelope", { message }));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      const duplicate = this.#responded.has(message.id);
      this.#report(
        new AcpWireProtocolError(
          duplicate ? "duplicate_response" : "late_response",
          duplicate ? "Duplicate ACP response" : "ACP response has no pending request",
          { id: message.id },
        ),
      );
      return;
    }
    this.#pending.delete(message.id);
    this.#responded.add(message.id);
    this.#scheduler.clear(pending.timer);
    if (message.error !== undefined) {
      pending.reject(
        new AcpWireProtocolError("remote_error", `ACP request ${pending.method} failed`, {
          error: message.error,
          id: message.id,
          method: pending.method,
        }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #failPending(error: AcpWireTransportError): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      this.#scheduler.clear(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #report(error: AcpWireProtocolError): void {
    this.#options.onProtocolError?.(error);
  }
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export const parseInitializeResult = (
  value: unknown,
  supportedVersions: readonly number[],
): AcpInitializeResult => {
  if (!isRecord(value) || !Number.isSafeInteger(value.protocolVersion)) {
    throw new AcpWireProtocolError("invalid_message", "Invalid ACP initialize result", { value });
  }
  const protocolVersion = value.protocolVersion as number;
  if (!supportedVersions.includes(protocolVersion)) {
    throw new AcpWireProtocolError("unsupported_protocol", "ACP protocol version is unsupported", {
      protocolVersion,
      supportedVersions,
    });
  }
  return {
    protocolVersion,
    capabilities: isRecord(value.agentCapabilities) ? value.agentCapabilities : {},
    raw: value,
  };
};
