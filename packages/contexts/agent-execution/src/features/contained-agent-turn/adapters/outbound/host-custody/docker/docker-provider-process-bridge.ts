import {captureDockerHttpResourceRecord} from "./docker-http-network-resources.js";
import {isDeepStrictEqual, types} from "node:util";
import {assertDockerProviderProcessClaimActive, prepareDockerProviderProcessLaunch, claimDockerProviderProcessLaunch, type DockerHostCustodyLifecycle} from "./docker-host-custody-lifecycle.js";
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
  readonly preparedIo?: PreparedDockerProviderIo;
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

/** Same-object private handoff; readiness is init readiness, never provider execution. */
export interface PreparedDockerProviderIo {
  ready(): ReturnType<DockerContainedTurnInitSession["ready"]>;
  readonly observation: DockerContainedTurnInitSession["observation"];
  readonly completion: DockerContainedTurnInitSession["completion"];
}
type PreparationInput = Readonly<Pick<DockerProviderProcessInput, "launch" | "expected" | "init">>;
const observed = new WeakMap<PreparedDockerProviderIo, PreparationInput["launch"]>();
export const assertDockerPreparedIoLaunch = (io: PreparedDockerProviderIo, launch: PreparationInput["launch"]): void => {
  if (observed.get(io) !== launch) {throw new TypeError("Docker evidence requires the actual prepared IO launch");}
};
const prepared = new WeakMap<PreparedDockerProviderIo, Readonly<{
  launch: DockerProviderProcessInput["launch"]; expected: DockerProviderProcessInput["expected"];
  isAdmitted(): boolean; init: DockerProviderProcessInput["init"]; process: DockerProviderProcess; session: DockerContainedTurnInitSession;
}>>();
const applyCallback = Reflect.apply;
const captureInit = (value: DockerProviderProcessInput["init"]): DockerProviderProcessInput["init"] => {
  const options = captureDockerHttpResourceRecord(value);
  if ((typeof options.isCurrentGeneration !== "function" || types.isProxy(options.isCurrentGeneration))
    || (options.isObservationActive !== undefined && (typeof options.isObservationActive !== "function" || types.isProxy(options.isObservationActive)))
    || (options.monotonicNow !== undefined && (typeof options.monotonicNow !== "function" || types.isProxy(options.monotonicNow)))) {
    throw new TypeError("Docker provider IO requires inert callbacks");
  }
  const authority = captureDockerHttpResourceRecord(options.authority);
  return Object.freeze({...options, authority: Object.freeze({...authority,
    expectedIdentity: captureDockerHttpResourceRecord(authority.expectedIdentity)})});
};
const capturePreparation = <T extends PreparationInput>(value: T): T => {
  const input = captureDockerHttpResourceRecord(value);
  const expected = captureDockerHttpResourceRecord(input.expected);
  captureInit(input.init); // Reject nested traps/accessors before claiming; retain callback receivers.
  return Object.freeze({...input, expected: Object.freeze({...expected,
    authority: Object.freeze({...captureDockerHttpResourceRecord(expected.authority)})})});
};

/** Installs bounded output custody before the sole session can become ready.
 * Does not consume the lifecycle's provider-execution claim or mount facts. */
const prepareIo = (input: PreparationInput, issued: ReturnType<typeof prepareDockerProviderProcessLaunch>): PreparedDockerProviderIo => {
  const expected = Object.freeze({...input.expected, authority: Object.freeze({...input.expected.authority})});
  const receiver = input.init;
  const options = captureInit(receiver);
  const init = Object.freeze({acknowledgementTimeoutMs: options.acknowledgementTimeoutMs,
    maximumStderrBytes: options.maximumStderrBytes, maximumStdoutBytes: options.maximumStdoutBytes,
    readyTimeoutMs: options.readyTimeoutMs,
    ...(options.signal === undefined ? {} : {signal: options.signal}),
    authority: Object.freeze({...options.authority,
    expectedIdentity: Object.freeze({...options.authority.expectedIdentity})}),
    isCurrentGeneration: (generation: string) => applyCallback(options.isCurrentGeneration, receiver, [generation]),
    ...(options.isObservationActive === undefined ? {} : {isObservationActive: () => applyCallback(options.isObservationActive!, receiver, [])}),
    ...(options.monotonicNow === undefined ? {} : {monotonicNow: () => applyCallback(options.monotonicNow!, receiver, [])})});
  if (!sameDockerAuthority(expected.authority, issued.authority) || expected.custodyRef !== issued.custodyRef ||
      expected.workspaceAuthorityPath !== issued.workspaceAuthorityPath || expected.generation !== init.authority.generation) {
    throw new TypeError("Docker provider process does not match exact launch authority");
  }
  const process = new DockerProviderProcess(issued.custodyRef, issued.workspaceAuthorityPath);
  const session = issued.openInitSession({...init, onOutput: chunk => process[chunk.stream].push(chunk.bytes)});
  process.bind(session, expected.generation);
  const capability = Object.freeze({ready: session.ready.bind(session), completion: session.completion, get observation() {return session.observation;}});
  observed.set(capability, input.launch);
  prepared.set(capability, Object.freeze({isAdmitted: () => !init.signal?.aborted && init.isCurrentGeneration(expected.generation),
    launch: input.launch, expected, init: captureInit(options), process, session}));
  return capability;
};

export const prepareDockerProviderProcessIo = (value: PreparationInput): PreparedDockerProviderIo => {
  const input = capturePreparation(value);
  return prepareIo(input, prepareDockerProviderProcessLaunch(input.launch));
};

// Private composition capability, deliberately absent from the process DTO.
// Claiming removes the lookup; either stream's first iterator fences both streams.
const unpublished = new WeakMap<object, () => void>();
export const takeDockerProviderProcessAbandonment = (process: object): (() => void) => {
  const abandon = unpublished.get(process);
  if (abandon === undefined) {throw new TypeError("Docker publication capability is unavailable");}
  unpublished.delete(process);
  return abandon;
};

/** The only async creation path consumes an actual lifecycle-issued launch. */
export const createDockerProviderProcessBridge = () => Object.freeze({
  async open(value: DockerProviderProcessInput) {
    const input = capturePreparation(value);
    // The absent optional capability preserves standalone consumers only. A
    // supplied invalid capability never falls back to another attach/session.
    const issued = claimDockerProviderProcessLaunch(input.launch);
    const capability = input.preparedIo === undefined ? prepareIo(input, issued) : input.preparedIo;
    const retained = prepared.get(capability);
    if (retained === undefined || retained.launch !== input.launch ||
        !sameDockerAuthority(retained.expected.authority, issued.authority) ||
        retained.expected.custodyRef !== issued.custodyRef ||
        retained.expected.workspaceAuthorityPath !== issued.workspaceAuthorityPath ||
        !isDeepStrictEqual(retained.expected, input.expected) || !isDeepStrictEqual(retained.init, captureInit(input.init))) {
      throw new TypeError("Docker prepared IO requires the exact unused launch and captured configuration");
    }
    prepared.delete(capability); // Fence before readiness or journal effects.
    const {process, session, expected} = retained;
    const call = Object.freeze({...input.call});
    const exec = Object.freeze({...input.exec, argv: Object.freeze([...input.exec.argv]),
      environment: Object.freeze(input.exec.environment.map(item => Object.freeze({...item})))});
    const joined = input.preparedIo !== undefined;
    const assertAdmitted = () => {
      assertDockerProviderProcessClaimActive(issued);
      if (call.signal.aborted || Date.now() >= call.deadlineEpochMs || !retained.isAdmitted()) {throw new DockerProviderProcessIoError("execution-call-aborted");}
    };
    try {
      if (!joined) {
        const abort = () => process.fail(new DockerProviderProcessIoError("execution-call-aborted"));
        call.signal.addEventListener("abort", abort, {once: true});
        void session.completion.then(() => call.signal.removeEventListener("abort", abort));
        if (call.signal.aborted) {abort();}
      }
      assertAdmitted();
      const ready = await session.ready();
      if (ready.kind !== "ready" || ready.generation !== expected.generation) {
        throw new DockerProviderProcessIoError("authenticated-readiness-unproven");
      }
      assertAdmitted();
      const executed = await issued.execute(exec, call);
      assertAdmitted();
      if (executed.evidence.status !== "proved") {throw new DockerProviderProcessIoError("provider-exec-unproven");}
      let publication: "pending" | "owned" | "abandoned" = "pending";
      const stream = (output: DockerProviderOutput) => Object.freeze({[Symbol.asyncIterator]: () => {
        if (publication === "abandoned") {throw new TypeError("Docker process publication was abandoned");}
        publication = "owned";
        unpublished.delete(opened);
        return output[Symbol.asyncIterator]();
      }});
      const opened = Object.freeze({custodyRef: process.custodyRef, workspaceAuthorityPath: process.workspaceAuthorityPath,
        stdout: stream(process.stdout), stderr: stream(process.stderr),
        write: process.write.bind(process),
        closeInput: process.closeInput.bind(process), waitForExit: process.waitForExit.bind(process)});
      unpublished.set(opened, () => {
        if (publication !== "pending") {return;}
        publication = "abandoned";
        unpublished.delete(opened);
        if (joined) {process.stdout.drainUnpublished(); process.stderr.drainUnpublished();}
        else {process.fail(new DockerProviderProcessIoError("publication-abandoned"));}
      });
      return opened;
    } catch (error) {
      // Joined preparation retains observation custody across admission cutoff
      // and late acknowledgement. Host containment owns its bounded drain.
      if (joined) {process.stdout.drainUnpublished(); process.stderr.drainUnpublished();}
      else {process.fail(error instanceof Error ? error : new DockerProviderProcessIoError("creation-failed"));}
      throw error;
    }
  },
});
