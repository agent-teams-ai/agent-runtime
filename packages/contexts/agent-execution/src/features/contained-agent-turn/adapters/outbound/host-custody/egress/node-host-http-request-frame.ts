import { intrinsicUint8ArrayLength, zeroHttpBytes } from "./http-byte-intrinsics.js";
import type { FixedNodeHostHttpConnectionConfig } from "./node-host-http-connection-config.js";
import { parseBoundedRequestHead, StrictHttpRequestError } from "./strict-http-request.js";

const delimiter = [13, 10, 13, 10] as const;

/** One bounded raw frame; no HTTP normalization and no second-request parser. */
export class NodeHostHttpRequestFrame {
  readonly #config: FixedNodeHostHttpConnectionConfig;
  #head: Uint8Array | undefined;
  #frame: Uint8Array | undefined;
  #used = 0;
  #headEnd = 0;
  #observed = 0;
  #fields = -1;
  #previous = 0;
  #matched = 0;
  #complete = false;
  #released = false;

  public constructor(config: FixedNodeHostHttpConnectionConfig) {this.#config = config;}
  public get headComplete(): boolean {return this.#headEnd !== 0;}
  public get complete(): boolean {return this.#complete;}
  public get observedBytes(): number {return this.#observed;}
  public get bytes(): Uint8Array | undefined {return this.#frame;}

  public error(kind: StrictHttpRequestError["kind"]): StrictHttpRequestError {
    return new StrictHttpRequestError(kind, this.#observed);
  }

  public observePending(length: number): void {
    this.#observed = Math.min(Number.MAX_SAFE_INTEGER, this.#observed + length);
  }

  public push(chunk: unknown): void {
    const length = intrinsicUint8ArrayLength(chunk);
    if (length === undefined) {throw this.error("malformed");}
    this.#observed = Math.min(Number.MAX_SAFE_INTEGER, this.#observed + length);
    if (length === 0) {return;}
    if (this.#complete || this.#released) {throw this.error("smuggling");}
    // Check the entire chunk before any allocation/copy, even on the unit seam.
    if (length > this.#config.readHighWaterMark) {throw this.error("body_oversized");}
    const bytes = chunk as Uint8Array;
    let offset = 0;
    if (this.#headEnd === 0) {
      offset = this.#scanHead(bytes, length);
      if (this.#headEnd === 0) {return;}
    }
    const frame = this.#frame!;
    if (length - offset > frame.byteLength - this.#used) {throw this.error("smuggling");}
    // Direct indexed copying avoids caller-overridden slice/subarray/set hooks.
    for (; offset < length; offset += 1) {frame[this.#used++] = bytes[offset]!;}
    this.#complete = this.#used === frame.byteLength;
  }

  #scanHead(bytes: Uint8Array, length: number): number {
    this.#head ??= new Uint8Array(this.#config.limits.maxInboundHeaderBytes);
    for (let offset = 0; offset < length; offset += 1) {
      if (this.#used === this.#head.byteLength) {throw this.error("headers_oversized");}
      const byte = bytes[offset]!;
      // Conservative transport intersection: ASCII only, no controls or bare LF/CR.
      if ((byte < 32 && byte !== 13 && byte !== 10) || byte > 126
        || (byte === 10 && this.#previous !== 13) || (this.#previous === 13 && byte !== 10)) {
        throw this.error("malformed");
      }
      this.#head[this.#used++] = byte;
      if (byte === 10 && ++this.#fields > this.#config.maxHeaderFields + 1) {
        throw this.error("headers_oversized");
      }
      this.#matched = byte === delimiter[this.#matched] ? this.#matched + 1 : (byte === 13 ? 1 : 0);
      this.#previous = byte;
      if (this.#matched === 4) {
        this.#finishHead(length - offset - 1);
        return offset + 1;
      }
    }
    return length;
  }

  #finishHead(pendingBodyBytes: number): void {
    const parsed = parseBoundedRequestHead(this.#head!, this.#used - 4,
      this.#config.expectedRequest, this.#config.limits);
    if (parsed.headers.length > this.#config.maxHeaderFields) {throw this.error("headers_oversized");}
    if (pendingBodyBytes > parsed.contentLength) {throw this.error("smuggling");}
    // Content-Length and same-chunk surplus are checked BEFORE the body allocation.
    this.#headEnd = this.#used;
    this.#frame = new Uint8Array(this.#headEnd + parsed.contentLength);
    for (let index = 0; index < this.#used; index += 1) {this.#frame[index] = this.#head![index]!;}
    zeroHttpBytes(this.#head);
    this.#head = undefined;
  }

  public release(): void {
    zeroHttpBytes(this.#head);
    zeroHttpBytes(this.#frame);
    this.#head = undefined;
    this.#frame = undefined;
    this.#released = true;
  }
}
