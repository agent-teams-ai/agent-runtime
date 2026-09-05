import {createHash} from "node:crypto";
import {sameDockerAuthority} from "./docker-host-custody-lifecycle-guards.js";
import type {DockerContainerAuthority, DockerCustodyDuplexChannel, DockerEngineCall} from "./engine/docker-engine-port.js";
import {
  DockerCustodyInitHostSession,
  type DockerCustodyInitHostExec,
  type DockerCustodyInitHostOptions,
  type DockerCustodyInitHostStart,
} from "./init/docker-custody-init-host-session.js";

export type DockerContainedTurnInitSession = Pick<DockerCustodyInitHostSession,
  "ready" | "completion" | "writeInput" | "closeProviderInput" | "signal" | "cancel" | "close">;
export type DockerContainedTurnInitOptions = Omit<DockerCustodyInitHostOptions, "channel">;

/** Sole attach-channel custody for one lifecycle launch. No network/route readiness is inferred here. */
export class DockerContainedTurnHostCustody {
  #authority: DockerContainerAuthority | undefined;
  #channel: DockerCustodyDuplexChannel | undefined;
  #session: DockerCustodyInitHostSession | undefined;
  #cutoff = false;
  #executeUsed = false;
  #executionCall: DockerEngineCall | undefined;

  public owns(authority: DockerContainerAuthority): boolean {
    return this.#authority !== undefined && sameDockerAuthority(this.#authority, authority);
  }

  public assertOpen(call: DockerEngineCall): void {
    if (this.#cutoff || call.signal.aborted || Date.now() >= call.deadlineEpochMs) {
      this.#cutoff = true;
      throw new TypeError("Docker Host Custody launch authority is cut off");
    }
  }

  /** Called exactly once with lifecycle.launch's already-attached channel. */
  public retain(authority: DockerContainerAuthority, channel: DockerCustodyDuplexChannel): void {
    if (this.#authority !== undefined) {throw new TypeError("Docker custody attach retention is one-use");}
    this.#authority = authority;
    this.#channel = channel;
  }

  public openInitSession(options: DockerContainedTurnInitOptions, call: DockerEngineCall): DockerContainedTurnInitSession {
    this.assertOpen(call);
    const authority = this.#authority;
    if (authority === undefined || this.#channel === undefined || this.#session !== undefined) {
      throw new TypeError("Docker custody attach transfer is one-use");
    }
    if (options.authority.launchFingerprintSha256 !== authority.launchFingerprintSha256 ||
        createHash("sha256").update(options.authority.operationNonce).digest("hex") !== authority.operationNonceSha256 ||
        !authority.imageDigest.endsWith(`@sha256:${options.authority.expectedIdentity.containerImageSha256}`)) {
      throw new TypeError("Docker init session does not match retained launch authority");
    }
    const isCurrentGeneration = options.isCurrentGeneration;
    this.#session = new DockerCustodyInitHostSession({...options, channel: this.#channel,
      isCurrentGeneration: generation => !this.#cutoff && !call.signal.aborted &&
        (this.#executionCall === undefined || !this.#executionCall.signal.aborted && Date.now() < this.#executionCall.deadlineEpochMs) &&
        isCurrentGeneration(generation)});
    this.#channel = undefined;
    const session = this.#session;
    return Object.freeze({ready: session.ready.bind(session), completion: session.completion,
      writeInput: session.writeInput.bind(session), closeProviderInput: session.closeProviderInput.bind(session),
      signal: session.signal.bind(session), cancel: session.cancel.bind(session), close: session.close.bind(session)});
  }

  public beginExecute(call: DockerEngineCall): void {
    this.assertOpen(call);
    if (this.#executeUsed) {throw new TypeError("Docker Host Custody provider execution is one-use");}
    this.#executeUsed = true;
    this.#executionCall = Object.freeze({deadlineEpochMs: call.deadlineEpochMs, signal: call.signal});
    if (this.#session === undefined) {throw new TypeError("Docker init session is unavailable");}
    this.#session.assertReadyForExecution();
  }

  /** Called only after the lifecycle has acknowledged durable provider_exec_requested. */
  public execute(exec: DockerCustodyInitHostExec): Promise<DockerCustodyInitHostStart> {
    if (!this.#executeUsed || this.#cutoff || this.#session === undefined) {
      throw new TypeError("Docker provider execution is unavailable");
    }
    return this.#session.execute(exec);
  }

  public async close(): Promise<void> {
    this.#cutoff = true;
    const channel = this.#channel; this.#channel = undefined;
    if (this.#session !== undefined) {await this.#session.cancel();}
    else {await channel?.close();}
  }
}
