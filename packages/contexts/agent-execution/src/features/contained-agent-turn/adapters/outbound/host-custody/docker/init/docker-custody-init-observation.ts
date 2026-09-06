import {createHash, randomBytes} from "node:crypto";
import {DockerCustodyProtocolError, type DockerCustodyObservationBinding, type DockerCustodyProviderExecRequest, type DockerCustodyProviderInstance} from "./docker-custody-init-protocol.js";
import type {DockerCustodyInitHostAuthority, DockerCustodyInitHostResult, DockerCustodyInitHostRootExit} from "./docker-custody-init-host-session.js";

export interface DockerCustodyHostObservation {
  readonly authority: DockerCustodyInitHostAuthority;
  readonly channelEof: boolean;
  /** Equality at callback settlement; later writes to retained callback arrays cannot alter these hashes. */
  readonly consumerIntegrity: "intact" | "mutated";
  /** Sampled mapping of the retained child at native spawn; never whole-lifetime executable or pidfd custody. */
  readonly executableMapping: "observed" | "unproven";
  readonly executableSha256: string | null;
  readonly providerInstance: {readonly status: "missing"} | {
    readonly identity: DockerCustodyProviderInstance; readonly status: "observed" | "unproven";
  };
  readonly requestId: string | null;
  readonly rootExit: DockerCustodyInitHostRootExit | null;
  readonly status: "complete" | "incomplete" | "partial";
  readonly stderr: {readonly bytes: number; readonly sha256: string};
  readonly stdout: {readonly bytes: number; readonly sha256: string};
  /** Direct-child spawn/exit and output do not observe Engine/tini finality or descendant residue. */
  readonly supervisorFinality: "unproven";
}
export type DockerCustodyInitHostCompletion = DockerCustodyInitHostResult & {readonly observation: DockerCustodyHostObservation};

const stream = () => ({bytes: 0, hash: createHash("sha256")});
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const evidence = (value: ReturnType<typeof stream>) => Object.freeze({bytes: value.bytes, sha256: value.hash.copy().digest("hex")});

/** Bounded observation retained by the sole init session reader, independent of provider callbacks. */
export class DockerCustodyHostObservationWriter {
  public readonly binding: DockerCustodyObservationBinding;
  readonly #authority: DockerCustodyInitHostAuthority;
  readonly #stderr = stream();
  readonly #stdout = stream();
  #request: DockerCustodyProviderExecRequest | undefined;
  #instance: DockerCustodyProviderInstance | undefined;
  #mutated = false;
  #channelEof = false;
  #final: DockerCustodyHostObservation | undefined;

  public constructor(authority: DockerCustodyInitHostAuthority) {
    this.#authority = authority;
    this.binding = Object.freeze({challenge: randomBytes(32).toString("hex"), generation: authority.generation});
  }
  public bind(request: DockerCustodyProviderExecRequest): void {this.#request = request;}
  public acceptInstance(message: DockerCustodyProviderInstance, exited: boolean): void {
    const request = this.#request;
    if (this.#instance !== undefined || exited || request === undefined ||
      message.binding.challenge !== this.binding.challenge || message.binding.generation !== this.binding.generation ||
      message.requestId !== request.requestId || message.handshakeNonce !== request.handshakeNonce ||
      message.launchFingerprintSha256 !== request.launchFingerprintSha256 || message.executableSha256 !== request.executableSha256) {
      throw new DockerCustodyProtocolError("provider instance is duplicate, stale, or does not match exec authority");
    }
    this.#instance = message;
  }
  public acceptOutput(name: "stderr" | "stdout", bytes: Uint8Array): string {
    const value = name === "stderr" ? this.#stderr : this.#stdout;
    value.hash.update(bytes); value.bytes += bytes.byteLength;
    return digest(bytes);
  }
  public verifyConsumer(bytes: Uint8Array, expectedDigest: string): void {
    if (digest(bytes) !== expectedDigest) {
      this.#mutated = true; throw new DockerCustodyProtocolError("output consumer mutated observed bytes");
    }
  }
  public channelEnded(): void {this.#channelEof = true;}
  public snapshot(rootExit: DockerCustodyInitHostRootExit | undefined, active: boolean): DockerCustodyHostObservation {
    return this.#final ?? this.#snapshot(rootExit, active ? "partial" : "incomplete");
  }
  public finish(result: DockerCustodyInitHostResult, rootExit: DockerCustodyInitHostRootExit | undefined): DockerCustodyInitHostCompletion {
    this.#final = this.#snapshot(rootExit,
      result.kind === "closed" && this.#channelEof && this.#instance !== undefined && !this.#mutated ? "complete" : "incomplete");
    // Local evidence is deliberately non-enumerable: retain the legacy lifecycle result shape.
    return Object.freeze(Object.defineProperty({...result}, "observation", {value: this.#final})) as DockerCustodyInitHostCompletion;
  }
  #snapshot(rootExit: DockerCustodyInitHostRootExit | undefined,
    status: DockerCustodyHostObservation["status"]): DockerCustodyHostObservation {
    return Object.freeze({authority: this.#authority, channelEof: this.#channelEof, consumerIntegrity: this.#mutated ? "mutated" : "intact",
      executableMapping: status !== "incomplete" && this.#instance?.executableMapping !== undefined ? "observed" : "unproven",
      executableSha256: this.#request?.executableSha256 ?? null,
      providerInstance: this.#instance === undefined ? Object.freeze({status: "missing"})
        : Object.freeze({identity: this.#instance, status: status === "incomplete" ? "unproven" : "observed"}),
      requestId: this.#request?.requestId ?? null, rootExit: rootExit ?? null, status,
      stderr: evidence(this.#stderr), stdout: evidence(this.#stdout), supervisorFinality: "unproven"});
  }
}
