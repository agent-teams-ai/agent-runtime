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
  "observation" | "ready" | "completion" | "writeInput" | "closeProviderInput" | "signal" | "cancel" | "close">;
export type DockerContainedTurnInitOptions = Omit<DockerCustodyInitHostOptions, "channel">;

export interface DockerHostCustodyLifetime {
  readonly admission: Readonly<{signal: AbortSignal; deadlineEpochMs: number}>;
  readonly observation: Readonly<{isActive(): boolean}>;
}

/** Sole attach-channel custody for one lifecycle launch. No network/route readiness is inferred here. */
export class DockerContainedTurnHostCustody {
  #authority: DockerContainerAuthority | undefined;
  #channel: DockerCustodyDuplexChannel | undefined;
  #session: DockerCustodyInitHostSession | undefined;
  #cutoff = false;
  readonly #startAbort = new AbortController();
  #executeUsed = false;
  #executionCall: DockerEngineCall | undefined;
  #launchFinished = false;
  #closing: Promise<void> | undefined;
  #channelClosed = false;

  readonly #admissionCleanup: (() => void)[] = [];
  public constructor(private readonly lifetime?: DockerHostCustodyLifetime) {
    if (lifetime !== undefined) {this.watchAdmission(lifetime.admission);}
  }

  private watchAdmission(call: DockerEngineCall): void {
    const cutoff = () => this.cutOffAdmission();
    call.signal.addEventListener("abort", cutoff, {once: true});
    const timer = setTimeout(cutoff, Math.max(0, Math.min(2_147_483_647, call.deadlineEpochMs - Date.now())));
    timer.unref();
    this.#admissionCleanup.push(() => {clearTimeout(timer); call.signal.removeEventListener("abort", cutoff);});
    if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {cutoff();}
  }

  public finishLaunch(): void {this.#launchFinished = true;}

  /** Irreversible command cutoff; authenticated observations retain their own lifetime. */
  public cutOffAdmission(): void {this.#cutoff = true; this.#session?.cutOffAdmission(); this.#startAbort.abort();}

  /** Fence queued Docker start without aborting the separately retained attach call. */
  public startCall(call: DockerEngineCall): DockerEngineCall {
    this.assertOpen(call);
    return Object.freeze({deadlineEpochMs: call.deadlineEpochMs, signal: AbortSignal.any([call.signal, this.#startAbort.signal])});
  }

  public get cleanupComplete(): boolean {
    return this.#launchFinished && this.#cutoff && (this.#session !== undefined
      ? this.#session.cleanupComplete : this.#channel === undefined || this.#channelClosed);
  }

  public owns(authority: DockerContainerAuthority): boolean {
    return this.#authority !== undefined && sameDockerAuthority(this.#authority, authority);
  }

  public assertOpen(call: DockerEngineCall): void {
    if (this.#cutoff || call.signal.aborted || Date.now() >= call.deadlineEpochMs ||
        this.lifetime?.admission.signal.aborted || Date.now() >= (this.lifetime?.admission.deadlineEpochMs ?? Infinity)) {
      this.cutOffAdmission();
      throw new TypeError("Docker Host Custody launch authority is cut off");
    }
  }

  /** Called exactly once with lifecycle.launch's already-attached channel. */
  public retain(authority: DockerContainerAuthority, channel: DockerCustodyDuplexChannel): void {
    if (this.#authority !== undefined) {throw new TypeError("Docker custody attach retention is one-use");}
    this.#authority = authority;
    this.#channel = channel;
    if (this.#cutoff) {void this.close();}
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
    const {signal, ...observationOptions} = options;
    if (this.lifetime !== undefined && signal !== undefined) {
      this.watchAdmission({signal, deadlineEpochMs: this.lifetime.admission.deadlineEpochMs});
    }
    const channel = this.#channel;
    const retainedChannel: DockerCustodyDuplexChannel = this.lifetime === undefined ? channel : {
      output: channel.output, close: channel.close.bind(channel), closeInput: channel.closeInput.bind(channel),
      write: (bytes, assertAdmission) => channel.write(bytes, () => {
        // Recheck at the transport's actual commit, including after a queue wait.
        const admission = this.lifetime!.admission;
        const execution = this.#executionCall;
        if (admission.signal.aborted || Date.now() >= admission.deadlineEpochMs ||
            execution !== undefined && (execution.signal.aborted || Date.now() >= execution.deadlineEpochMs)) {
          this.cutOffAdmission();
        }
        assertAdmission?.();
      }),
    };
    this.#session = new DockerCustodyInitHostSession({...observationOptions,
      ...(this.lifetime === undefined && signal !== undefined ? {signal} : {}), channel: retainedChannel,
      isObservationActive: () => this.lifetime !== undefined
        ? this.lifetime.observation.isActive() && (options.isObservationActive?.() ?? true)
        : !call.signal.aborted &&
        (this.#executionCall === undefined || !this.#executionCall.signal.aborted && Date.now() < this.#executionCall.deadlineEpochMs) &&
        (options.isObservationActive?.() ?? true), isCurrentGeneration});
    if (this.#cutoff) {this.#session.cutOffAdmission();}
    this.#channel = undefined;
    const session = this.#session;
    void session.completion.then(() => {for (const cleanup of this.#admissionCleanup.splice(0)) {cleanup();}});
    return Object.freeze({get observation() {return session.observation;}, ready: session.ready.bind(session), completion: session.completion,
      writeInput: session.writeInput.bind(session), closeProviderInput: session.closeProviderInput.bind(session),
      signal: session.signal.bind(session), cancel: session.cancel.bind(session), close: session.close.bind(session)});
  }

  public beginExecute(call: DockerEngineCall): void {
    this.assertOpen(call);
    if (this.#executeUsed) {throw new TypeError("Docker Host Custody provider execution is one-use");}
    this.#executeUsed = true;
    if (this.lifetime !== undefined) {this.watchAdmission(call);}
    this.#executionCall = Object.freeze({deadlineEpochMs: call.deadlineEpochMs, signal: call.signal});
    if (this.#session === undefined) {throw new TypeError("Docker init session is unavailable");}
    this.#session.assertReadyForExecution();
  }

  /** Called only after the lifecycle has acknowledged durable provider_exec_requested. */
  public execute(exec: DockerCustodyInitHostExec): Promise<DockerCustodyInitHostStart> {
    if (!this.#executeUsed || this.#cutoff || this.#session === undefined) {
      throw new TypeError("Docker provider execution is unavailable");
    }
    if (this.#executionCall !== undefined) {this.assertOpen(this.#executionCall);}
    return this.#session.execute({...exec, wallDeadlineUnixMs: Math.min(exec.wallDeadlineUnixMs,
      this.#executionCall?.deadlineEpochMs ?? Infinity, this.lifetime?.admission.deadlineEpochMs ?? Infinity)});
  }

  public close(): Promise<void> {
    this.cutOffAdmission();
    for (const cleanup of this.#admissionCleanup.splice(0)) {cleanup();}
    if (this.#closing !== undefined) {return this.#closing;}
    if (this.#session === undefined && this.#channel === undefined) {return Promise.resolve();}
    // Publish the shared cleanup before calling external code; retain handles on stall or rejection.
    this.#closing = Promise.resolve().then(async () => {
      if (this.#session !== undefined) {await this.#session.cancel();}
      else {await this.#channel!.close(); this.#channelClosed = true;}
      return;
    }).catch(() => {});
    return this.#closing;
  }

  /** Docker removal retires its hijack, so join the reader after stop and before removal. */
  public async drainWithin(call: DockerEngineCall): Promise<void> {
    this.cutOffAdmission();
    await this.waitWithin(this.#session?.drain() ?? Promise.resolve(), call);
  }

  /** Called only after physical containment; a deadline cannot discard the retained cleanup. */
  public async closeWithin(call: DockerEngineCall): Promise<boolean> {
    const closing = this.close();
    if (this.cleanupComplete) {return true;}
    await this.waitWithin(closing, call);
    return this.cleanupComplete;
  }

  private async waitWithin(pending: Promise<void>, call: DockerEngineCall): Promise<void> {
    if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {void this.close(); return;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([pending, new Promise<void>(resolve => {
        abort = () => {void this.close(); resolve();};
        call.signal.addEventListener("abort", abort, {once: true});
        timer = setTimeout(abort, Math.max(0, call.deadlineEpochMs - Date.now()));
      })]);
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
      if (abort !== undefined) {call.signal.removeEventListener("abort", abort);}
    }
  }
}
