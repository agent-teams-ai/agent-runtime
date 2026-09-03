import type {DockerCustodyCommittedWriteResult, DockerCustodyInitSnapshot} from "./docker-custody-init-runtime-types.js";

export class DockerCustodyProviderInputWriter {
  public bytes = 0;
  #pending: Uint8Array | null = null;
  #pendingCursor = 0;
  readonly #write: (bytes: Uint8Array) => DockerCustodyCommittedWriteResult;
  public status: DockerCustodyInitSnapshot["stdinStatus"] = "open";

  public constructor(
    public readonly maximumBytes: number,
    write: (bytes: Uint8Array) => DockerCustodyCommittedWriteResult,
  ) {this.#write = write;}

  public offer(bytes: Uint8Array): "accepted" | "blocked" | "closed" {
    if (this.status === "closed" || this.status === "overflow") {return "closed";}
    if (this.status === "blocked") {return "blocked";}
    if (this.bytes + bytes.byteLength > this.maximumBytes) {this.status = "overflow"; return "closed";}
    this.#pending = Uint8Array.from(bytes); this.#pendingCursor = 0; return this.#flush();
  }

  public drain(): void {
    if (this.status === "blocked") {this.status = "open"; this.#flush();}
  }

  public close(): void {this.#pending = null; this.#pendingCursor = 0; this.status = "closed";}

  #flush(): "accepted" | "blocked" | "closed" {
    const pending = this.#pending;
    if (pending === null) {return this.status === "closed" ? "closed" : "accepted";}
    if (this.#pendingCursor === pending.byteLength) {this.closePending(); return "accepted";}
    const offered = pending.subarray(this.#pendingCursor).slice();
    const result = this.#write(offered);
    if ((result.status !== "accepted" && result.status !== "blocked" && result.status !== "closed") ||
      !Number.isSafeInteger(result.committedBytes) || result.committedBytes < 0 || result.committedBytes > offered.byteLength ||
      result.status === "accepted" && result.committedBytes !== offered.byteLength || result.status === "closed" && result.committedBytes !== 0) {
      throw new Error("provider input write returned an invalid cursor");
    }
    this.bytes += result.committedBytes; this.#pendingCursor += result.committedBytes;
    if (result.status === "closed") {this.close(); return "closed";}
    if (result.status === "blocked") {this.status = "blocked"; return "blocked";}
    this.closePending(); return "accepted";
  }

  private closePending(): void {this.#pending = null; this.#pendingCursor = 0; this.status = "open";}
}
