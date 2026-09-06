import {claimDockerProviderProcessLaunch, type DockerHostCustodyLifecycle} from "./docker-host-custody-lifecycle.js";
import {sameDockerAuthority} from "./docker-host-custody-lifecycle-guards.js";
import type {DockerContainedTurnInitOptions, DockerContainedTurnInitSession} from "./docker-contained-turn-host-custody.js";
import type {DockerContainerAuthority, DockerEngineCall} from "./engine/docker-engine-port.js";
import {DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES} from "./init/docker-custody-init-protocol.js";
import type {DockerCustodyInitHostExec, DockerCustodyInitHostResult,
  DockerCustodyInitHostWriteResult} from "./init/docker-custody-init-host-session.js";
import {DockerProviderOutput} from "./docker-provider-output.js";

/** Bound for one logical provider write; wire frames retain their smaller protocol bound. */
export const DOCKER_PROVIDER_MAX_WRITE_BYTES = 16 * 1_048_576;

export interface DockerProviderProcessInput {
  readonly launch: Awaited<ReturnType<DockerHostCustodyLifecycle["launch"]>>;
  readonly expected: Readonly<{authority: DockerContainerAuthority; custodyRef: string;
    generation: string; workspaceAuthorityPath: string}>;
  readonly call: DockerEngineCall;
  readonly exec: DockerCustodyInitHostExec;
  readonly init: Omit<DockerContainedTurnInitOptions, "onOutput" | "onRootExit" | "onDrainComplete">;
}

export class DockerProviderProcessIoError extends Error {
  public constructor(
    public readonly reason: string,
    public readonly writeResult?: DockerCustodyInitHostWriteResult,
  ) {super(`Docker provider process IO: ${reason}`); this.name = "DockerProviderProcessIoError";}
}

/** IO only: waitForExit joins authenticated root exit AND verified drain. Neither
 * it nor EOF proves physical containment. Construction creates no session or IO. */
class DockerProviderProcess {
  public readonly stdout = new DockerProviderOutput(error => this.fail(error));
  public readonly stderr = new DockerProviderOutput(error => this.fail(error));
  #session: DockerContainedTurnInitSession | undefined;
  #failure: Error | undefined;
  #completion: DockerCustodyInitHostResult | undefined;
  #inputClosed = false;
  #write: Promise<void> | undefined;
  #close: Promise<void> | undefined;
  #interruptWrite: (() => void) | undefined;
  readonly #exit = Promise.withResolvers<Readonly<{code: number | null; signal: NodeJS.Signals | null}>>();

  public constructor(public readonly custodyRef: string, public readonly workspaceAuthorityPath: string) {
    // A failed launch may never publish this process to an exit waiter.
    void this.#exit.promise.catch(() => {});
  }

  public bind(session: DockerContainedTurnInitSession, generation: string): void {
    this.#session = session;
    void session.completion.then(result => {
      this.#completion = result;
      if (this.#write !== undefined || this.#interruptWrite !== undefined) {
        this.fail(new DockerProviderProcessIoError("write-completion-unknown", {kind: "unknown", committedBytes: "unknown"}));
        return;
      }
      if (result.kind !== "closed" || result.generation !== generation) {
        this.fail(new DockerProviderProcessIoError(result.kind === "closed" ? "generation-mismatch" : result.reason));
      } else if (result.rootExit.signal === "SIGEMT") {
        this.fail(new DockerProviderProcessIoError("unsupported-exit-signal"));
      } else if (this.#failure === undefined) {
        this.stdout.finish(); this.stderr.finish();
        this.#exit.resolve(Object.freeze({code: result.rootExit.exitCode, signal: result.rootExit.signal}));
      }
      return;
    }, () => this.fail(new DockerProviderProcessIoError("completion-rejected")));
  }

  public fail(error: Error): void {
    if (this.#failure !== undefined) {return;}
    this.#failure = error; this.#interruptWrite?.();
    this.stdout.finish(error); this.stderr.finish(error); this.#exit.reject(error);
    // The actual lifecycle continues retaining cleanup even if it stalls or rejects.
    this.cancelSession();
  }

  private cancelSession(): void {void this.#session?.cancel().catch(() => {});}

  public waitForExit(): Promise<Readonly<{code: number | null; signal: NodeJS.Signals | null}>> {return this.#exit.promise;}

  public write(bytes: Uint8Array): Promise<void> {
    if (this.#failure !== undefined) {return Promise.reject(this.#failure);}
    if (this.#inputClosed || this.#close !== undefined || this.#completion !== undefined) {
      return Promise.reject(new DockerProviderProcessIoError("input-closed", {kind: "closed", committedBytes: 0}));
    }
    if (this.#write !== undefined) {return Promise.reject(new DockerProviderProcessIoError("write-in-progress"));}
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > DOCKER_PROVIDER_MAX_WRITE_BYTES) {
      return Promise.reject(new DockerProviderProcessIoError("input-bound-exceeded"));
    }
    const snapshot = Uint8Array.from(bytes);
    const pending = Promise.resolve().then(async () => {
      for (let offset = 0; offset < snapshot.byteLength; offset += DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES) {
        if (this.#failure !== undefined) {throw this.#failure;}
        const frame = snapshot.subarray(offset, offset + DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES);
        await this.writeOnce(() => this.#session!.writeInput(frame), frame.byteLength, offset);
      }
      return;
    });
    this.#write = pending;
    void pending.then(() => {this.#write = undefined; return;}, () => {this.#write = undefined; return;});
    return pending;
  }

  public closeInput(): Promise<void> {
    // Publish the one shared promise before invoking the session. A failed or
    // ambiguous close remains rejected forever; subsequent calls never retry.
    this.#close ??= Promise.resolve(this.#write).then(() => {
      if (this.#failure !== undefined) {throw this.#failure;}
      if (this.#inputClosed || this.#completion !== undefined) {
        throw new DockerProviderProcessIoError("input-closed", {kind: "closed", committedBytes: 0});
      }
      return this.writeOnce(() => this.#session!.closeProviderInput(), 0);
    });
    return this.#close;
  }

  private async writeOnce(write: () => Promise<DockerCustodyInitHostWriteResult>, bytes: number, committedPrefix = 0): Promise<void> {
    const interrupted = Promise.withResolvers<DockerCustodyInitHostWriteResult>();
    let admissionRejection: DockerProviderProcessIoError | undefined;
    // One fixed pending-write slot, not one retained completion reaction per write.
    this.#interruptWrite = () => interrupted.resolve({kind: "unknown", committedBytes: "unknown"});
    try {
      // Completion/abort cannot prove zero bytes for a pending channel write.
      const result = await Promise.race([write(), interrupted.promise]);
      if (result.kind === "closed" && result.committedBytes === 0 && committedPrefix === 0 && this.#failure === undefined) {
        // Admission rejected this entire logical operation before any bytes or
        // EOF committed. Seal input without cancelling the sole output reader:
        // the Host still owns physical stop, final observations and cleanup.
        this.#inputClosed = true;
        admissionRejection = new DockerProviderProcessIoError("input-write-unacknowledged", result);
      } else if (result.kind !== "committed" || result.committedBytes !== bytes) {
        throw new DockerProviderProcessIoError("input-write-unacknowledged", committedPrefix === 0
          ? result : {kind: "unknown", committedBytes: "unknown"});
      }
      if (this.#failure !== undefined) {
        throw new DockerProviderProcessIoError("write-completion-unknown", {kind: "unknown", committedBytes: "unknown"});
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new DockerProviderProcessIoError("input-write-failed"));
      throw error;
    } finally {this.#interruptWrite = undefined;}
    // Expected zero-effect rejection remains an honest method failure, outside
    // the fatal IO path. Unknown results and committed prefixes still fail above.
    if (admissionRejection !== undefined) {throw admissionRejection;}
  }
}

/** The only async creation path consumes an actual lifecycle-issued launch.
 * No synchronous SDK spawn acknowledgement or alternate process exists here. */
export const createDockerProviderProcessBridge = () => Object.freeze({
  async open(input: DockerProviderProcessInput) {
    const issued = claimDockerProviderProcessLaunch(input.launch);
    const expected = Object.freeze({...input.expected, authority: Object.freeze({...input.expected.authority})});
    const call = Object.freeze({...input.call});
    const exec = Object.freeze({...input.exec, argv: Object.freeze([...input.exec.argv]),
      environment: Object.freeze(input.exec.environment.map(item => Object.freeze({...item})))});
    const options = input.init;
    const init = Object.freeze({acknowledgementTimeoutMs: options.acknowledgementTimeoutMs,
      maximumStderrBytes: options.maximumStderrBytes, maximumStdoutBytes: options.maximumStdoutBytes,
      readyTimeoutMs: options.readyTimeoutMs,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
      authority: Object.freeze({...options.authority,
      expectedIdentity: Object.freeze({...options.authority.expectedIdentity})}),
      isCurrentGeneration: options.isCurrentGeneration.bind(options),
      ...(options.isObservationActive === undefined ? {} : {isObservationActive: options.isObservationActive.bind(options)}),
      ...(options.monotonicNow === undefined ? {} : {monotonicNow: options.monotonicNow.bind(options)})});
    if (!sameDockerAuthority(expected.authority, issued.authority) || expected.custodyRef !== issued.custodyRef ||
        expected.workspaceAuthorityPath !== issued.workspaceAuthorityPath || expected.generation !== init.authority.generation) {
      throw new TypeError("Docker provider process does not match exact launch authority");
    }
    const process = new DockerProviderProcess(issued.custodyRef, issued.workspaceAuthorityPath);
    try {
      const session = issued.openInitSession({...init, onOutput: chunk => process[chunk.stream].push(chunk.bytes)});
      process.bind(session, expected.generation);
      const abort = () => process.fail(new DockerProviderProcessIoError("execution-call-aborted"));
      call.signal.addEventListener("abort", abort, {once: true});
      void session.completion.then(() => call.signal.removeEventListener("abort", abort));
      if (call.signal.aborted) {abort();}
      const ready = await session.ready();
      if (ready.kind !== "ready" || ready.generation !== expected.generation) {
        throw new DockerProviderProcessIoError("authenticated-readiness-unproven");
      }
      const executed = await issued.execute(exec, call);
      if (executed.evidence.status !== "proved") {throw new DockerProviderProcessIoError("provider-exec-unproven");}
      return Object.freeze({custodyRef: process.custodyRef, workspaceAuthorityPath: process.workspaceAuthorityPath,
        stdout: Object.freeze({[Symbol.asyncIterator]: process.stdout[Symbol.asyncIterator].bind(process.stdout)}),
        stderr: Object.freeze({[Symbol.asyncIterator]: process.stderr[Symbol.asyncIterator].bind(process.stderr)}),
        write: process.write.bind(process),
        closeInput: process.closeInput.bind(process), waitForExit: process.waitForExit.bind(process)});
    } catch (error) {
      process.fail(error instanceof Error ? error : new DockerProviderProcessIoError("creation-failed")); throw error;
    }
  },
});
