import { DockerEngineError } from "./docker-engine-error.js";
import type {
  DockerContainerAuthority,
  DockerContainerStateFacts,
  DockerCustodyDuplexChannel,
  DockerEngineCall,
} from "./docker-engine-port.js";

interface FakeAttachInput {
  readonly authority: DockerContainerAuthority;
  readonly call: DockerEngineCall;
  readonly checkContinuation: () => void;
  readonly endpointCustodyLost: () => boolean;
  readonly openRecord: () => Promise<Readonly<{ state: DockerContainerStateFacts }>>;
  readonly recordEvent: () => void;
}

export class FakeDockerAttachCustody {
  readonly #cleanup = new Map<string, () => void>();
  readonly #generation = new Map<string, symbol>();
  readonly #input = new Map<string, Uint8Array[]>();
  readonly #retire = new Map<string, () => void>();
  readonly #state = new Map<string, "invalid" | "opening" | "open" | "starting" | "started">();

  public custodyInput(authority: DockerContainerAuthority): Uint8Array {
    return Uint8Array.from(Buffer.concat(
      (this.#input.get(authority.containerId) ?? []).map(bytes => Buffer.from(bytes)),
    ));
  }

  public beginStart(containerId: string): void {
    if (this.#state.get(containerId) !== "open") {
      throw new DockerEngineError("protocol-violation");
    }
    this.#state.set(containerId, "starting");
    if (this.#state.get(containerId) !== "starting") {
      throw new DockerEngineError("daemon-disconnected");
    }
    this.#state.set(containerId, "started");
  }

  public async open(input: FakeAttachInput): Promise<DockerCustodyDuplexChannel> {
    const id = input.authority.containerId;
    if (this.#state.has(id)) {throw new DockerEngineError("protocol-violation");}
    const generation = Symbol(id);
    this.#state.set(id, "opening");
    this.#generation.set(id, generation);
    let closed = false;
    let retired = false;
    let valid = true;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) {clearTimeout(timer);}
      input.call.signal.removeEventListener("abort", invalidate);
    };
    const invalidate = (): void => {
      if (!valid || retired) {return;}
      valid = false;
      cleanup();
      if (this.#generation.get(id) === generation) {this.#state.set(id, "invalid");}
    };
    timer = setTimeout(invalidate, Math.max(0, input.call.deadlineEpochMs - Date.now()));
    timer.unref();
    input.call.signal.addEventListener("abort", invalidate, { once: true });
    this.#cleanup.set(id, cleanup);
    this.#retire.set(id, () => {
      retired = true;
      closed = true;
      valid = false;
      cleanup();
    });
    if (input.call.signal.aborted || input.call.deadlineEpochMs <= Date.now()) {invalidate();}
    let state: DockerContainerStateFacts;
    try {
      state = (await input.openRecord()).state;
    } catch (error) {
      if (this.#state.has(id)) {this.#state.set(id, "invalid");}
      cleanup();
      throw error;
    }
    try {
      input.checkContinuation();
      if (input.endpointCustodyLost()) {throw new DockerEngineError("endpoint-custody-lost");}
      if (!valid || retired || this.#generation.get(id) !== generation || this.#state.get(id) !== "opening") {
        throw new DockerEngineError("protocol-violation");
      }
    } catch (error) {
      invalidate();
      throw error;
    }
    if (state.status !== "created" || state.running) {
      this.#state.set(id, "invalid");
      throw new DockerEngineError("protocol-violation");
    }
    this.#state.set(id, "open");
    this.#input.set(id, []);
    input.recordEvent();
    return Object.freeze({
      close: async () => {closed = true; invalidate();},
      closeInput: async () => {closed = true; invalidate();},
      output: (async function* () {try {yield* [];} finally {invalidate();}})(),
      write: async (bytes: Uint8Array) => {
        if (retired) {throw new DockerEngineError("protocol-violation");}
        if (closed || bytes.byteLength === 0 || this.#state.get(id) === "invalid") {
          this.#state.set(id, "invalid");
          throw new DockerEngineError("protocol-violation");
        }
        this.#input.get(id)?.push(bytes.slice());
      },
    });
  }

  public invalidate(containerId: string): void {
    this.#state.set(containerId, "invalid");
    this.#cleanup.get(containerId)?.();
    this.#cleanup.delete(containerId);
  }

  public retire(containerId: string): void {
    this.#retire.get(containerId)?.();
    this.#retire.delete(containerId);
    this.#cleanup.get(containerId)?.();
    this.#cleanup.delete(containerId);
    this.#state.delete(containerId);
    this.#generation.delete(containerId);
    this.#input.delete(containerId);
  }
}
