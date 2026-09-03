import { CodexAppServerProtocolError } from "./codex-app-server-jsonl.js";

/** Codex-specific bounded delta custody: append linearly and materialize exactly once. */
export class CodexAppServerTextSegments {
  readonly #chunks: string[] = [];
  readonly #maxBytes: number;
  readonly #maxChunks: number;
  #bytes = 0;
  #materialized = false;
  #materializationCount = 0;

  public constructor(maxBytes: number, maxChunks: number) {
    this.#maxBytes = maxBytes;
    this.#maxChunks = maxChunks;
  }

  public append(chunk: string): void {
    if (this.#materialized) {
      throw new CodexAppServerProtocolError("Codex text lifecycle was already materialized", true);
    }
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (this.#chunks.length + 1 > this.#maxChunks || this.#bytes + bytes > this.#maxBytes) {
      throw new CodexAppServerProtocolError("Codex text delta stream exceeded its bound", true);
    }
    this.#chunks.push(chunk);
    this.#bytes += bytes;
  }

  public materialize(): string {
    if (this.#materialized) {
      throw new CodexAppServerProtocolError("Codex text lifecycle was materialized more than once", true);
    }
    this.#materialized = true;
    this.#materializationCount += 1;
    return this.#chunks.join("");
  }

  public get byteLength(): number {return this.#bytes;}
  public get chunkCount(): number {return this.#chunks.length;}
  /** Deterministic copy-pass evidence for focused high-fragment tests. */
  public get materializationCount(): number {return this.#materializationCount;}
}
