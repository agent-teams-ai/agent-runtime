import type {DockerCustodyInitMessage} from "./docker-custody-init-protocol.js";

interface PendingControlEvidence<Generation> {
  readonly generation: Generation | null; readonly message: DockerCustodyInitMessage; readonly onAccepted: (() => void) | undefined;
}

export class DockerCustodyControlWriter<Generation> {
  readonly #evidence: PendingControlEvidence<Generation>[] = [];
  readonly #fail: () => void;
  #flushing = false;
  readonly #write: (message: DockerCustodyInitMessage) => "accepted" | "blocked";

  public constructor(
    write: (message: DockerCustodyInitMessage) => "accepted" | "blocked",
    fail: () => void,
  ) {this.#write = write; this.#fail = fail;}

  public clear(): void {this.#evidence.length = 0;}

  public enqueue(message: DockerCustodyInitMessage, generation: Generation | null, current: Generation | undefined, onAccepted?: () => void): void {
    this.#evidence.push(Object.freeze({generation, message, onAccepted})); this.flush(current);
  }

  public flush(current: Generation | undefined): void {
    if (this.#flushing) {return;}
    this.#flushing = true;
    try {
      while (this.#evidence.length > 0) {
        const pending = this.#evidence[0];
        if (pending === undefined) {break;}
        if (pending.generation !== null && pending.generation !== current) {this.#fail(); break;}
        let result: "accepted" | "blocked";
        try {result = this.#write(pending.message);} catch {this.#fail(); break;}
        if (result === "blocked") {break;}
        if (result !== "accepted") {this.#fail(); break;}
        this.#evidence.shift(); pending.onAccepted?.();
      }
    } finally {this.#flushing = false;}
  }
}
