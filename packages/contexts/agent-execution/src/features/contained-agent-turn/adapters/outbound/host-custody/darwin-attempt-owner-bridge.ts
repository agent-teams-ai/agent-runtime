import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { CustodiedProviderProcess, CustodiedProviderProcessExit } from "./custodied-provider-process.js";
import {
  DarwinAttemptOwnerEventReader, encodeDarwinAttemptOwnerRequest, darwinAttemptOwnerStates as native,
  DarwinWorkspaceTreeReceiver, captureDarwinWorkspaceTree, decodeDarwinNativeLaunchData, decodeDarwinNativeMaterialData,
  type DarwinNativeWorkspaceTree, type DarwinNativeWorkspaceTreeLimits, type DarwinAttemptOwnerCommand, type DarwinAttemptOwnerEvent, type DarwinNativeLaunchData, encodeDarwinNativeFinalLaunchData, type DarwinNativeFinalLaunchData,
} from "./darwin-attempt-owner-protocol.js";

// Fixed Darwin signal numbers: interpreting these with the build host's
// signal constants would silently misreport Darwin SIGBUS/SIGUSR1, etc.
// @types/node omits Darwin SIGEMT (7); the cast below is limited to that
// fixed Darwin signal name, never a caller string or host-dependent mapping.
const darwinSignals: readonly NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT",
  "SIGEMT" as NodeJS.Signals, "SIGFPE", "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGURG",
  "SIGSTOP", "SIGTSTP", "SIGCONT", "SIGCHLD", "SIGTTIN", "SIGTTOU", "SIGIO", "SIGXCPU", "SIGXFSZ",
  "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGINFO", "SIGUSR1", "SIGUSR2"];
function nativeOutput() {
  let bytes: Buffer | undefined, written = 0, read = 0, ended = false, consumed = false;
  let failure: Error | undefined, wake: (() => void) | undefined;
  const signal = (): void => {wake?.(); wake = undefined;};
  const iterable: AsyncIterable<Uint8Array> = Object.freeze({
    async *[Symbol.asyncIterator]() {
      if (consumed) {throw new Error("native output already consumed");}
      consumed = true;
      for (;;) {
        if (failure) {throw failure;}
        if (read < written) {
          const end = Math.min(written, read + 16384), chunk = Buffer.from(bytes!.subarray(read, end));
          read = end; yield chunk; continue;
        }
        if (ended) {return;}
        await new Promise<void>(resolve => {wake = resolve;});
      }
    },
  });
  return Object.freeze({iterable,
    push(chunk: Uint8Array): void {
      if (failure || ended || chunk.byteLength > 8388608 - written) {throw new Error("native output closed or budget exceeded");}
      bytes ??= Buffer.alloc(8388608);
      bytes.set(chunk, written); written += chunk.byteLength; signal();
    },
    end(): void {ended = true; signal();},
    lost(error: Error): void {if (!ended) {failure = error; signal();}},
  });
}
function nativeExecution() {
  const stdout = nativeOutput(), stderr = nativeOutput();
  let resolveImage!: () => void, rejectImage!: (error: Error) => void;
  let resolveExit!: (exit: CustodiedProviderProcessExit) => void, rejectExit!: (error: Error) => void;
  let imageSeen = false, outputBytes = 0;
  const image = new Promise<void>((resolve, reject) => {resolveImage = resolve; rejectImage = reject;});
  const exit = new Promise<CustodiedProviderProcessExit>((resolve, reject) => {resolveExit = resolve; rejectExit = reject;});
  void image.catch(() => {}); void exit.catch(() => {});
  return Object.freeze({image, exit, stdout: stdout.iterable, stderr: stderr.iterable,
    accept(event: DarwinAttemptOwnerEvent): void {
      switch (event.kind) {
        case "IMAGE": imageSeen = true; resolveImage(); break;
        case "STDOUT": case "STDERR":
          outputBytes += event.payload.length;
          if (outputBytes > 8388608) {throw new Error("native combined output budget exceeded");}
          (event.kind === "STDOUT" ? stdout : stderr).push(event.payload); break;
        case "EXIT": {
          if (!imageSeen) {rejectImage(new Error("native child exited before provider image observation"));}
          const signal = event.exitSignal ? darwinSignals[event.exitSignal - 1] : null;
          if (signal === undefined) {throw new Error("unknown Darwin native exit signal");}
          resolveExit(Object.freeze({code: event.exitCode ?? null, signal})); break;
        }
        case "STREAMS": stdout.end(); stderr.end(); break;
        default: break;
      }
    },
    lost(error: Error): void {rejectImage(error); rejectExit(error); stdout.lost(error); stderr.lost(error);},
  });
}

function nativeInput(
  request: (command: DarwinAttemptOwnerCommand, argument?: number, payload?: Buffer) => Promise<DarwinAttemptOwnerEvent>,
  current: () => boolean, lose: (error: unknown) => void,
) {
  let tail: Promise<void> = Promise.resolve(), queuedBytes = 0, closed = false;
  const enqueue = (bytes?: Buffer): Promise<void> => {
    const run = async (): Promise<void> => {
      if (!current()) {throw new Error("native input unavailable or cut off");}
      if (!bytes) {await request("CLOSE_INPUT"); return;}
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        if (!current()) {throw new Error("native input cut off during write");}
        const chunk = bytes.subarray(offset, offset + 16384);
        await request("WRITE_INPUT", chunk.length, chunk);
      }
    };
    const operation = tail.then(run);
    tail = operation;
    // Any partial uncertainty burns the transport; queued writes never retry.
    void operation.catch(lose);
    return operation.finally(() => {if (bytes) {queuedBytes -= bytes.length; bytes.fill(0);}});
  };
  return Object.freeze({
    writeInput(bytes: Uint8Array): Promise<void> {
      if (closed || !current() || !(bytes instanceof Uint8Array) || !bytes.byteLength ||
          bytes.byteLength > 1048576 - queuedBytes) {return Promise.reject(new Error("native input closed or queue budget exceeded"));}
      const captured = Buffer.from(bytes); // Before await or caller mutation.
      queuedBytes += captured.length;
      return enqueue(captured);
    },
    closeInput(): Promise<void> {
      if (closed || !current()) {return Promise.reject(new Error("native input already closed or unavailable"));}
      closed = true;
      return enqueue();
    },
  });
}

/** Selected once by the exact admitted Host composition, before START. There is
 * no submitEvidence/receipt-ID/boolean registration API. Only these retained
 * owner callbacks can supply settlement. This adapter does not issue a public
 * proof, activate a profile, elevate, spawn or interpret helper exit as child
 * exit. Root must bind it to the exclusively inherited native-created endpoint;
 * injecting a Duplex from arbitrary application code is NOT root admission. */
export interface DarwinAttemptRetainedCompletion {
  readonly binding: string;
  readonly launch: string;
  readonly namespace: string;
  readonly workspaceDev: string;
  readonly workspaceIno: string;
}
export interface DarwinAttemptRetainedOwners {
  readonly launchRoute: () => Promise<DarwinAttemptRetainedCompletion>;
  readonly artifactResult: () => Promise<DarwinAttemptRetainedCompletion>;
  readonly workspace: () => Promise<DarwinAttemptRetainedCompletion>;
  readonly privateMaterial: () => Promise<DarwinAttemptRetainedCompletion>;
  readonly output: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>;
}
const sameBirth = (a: DarwinAttemptOwnerEvent["owner"], b: DarwinAttemptOwnerEvent["owner"]): boolean =>
  a.pid === b.pid && a.ppid === b.ppid && a.pgid === b.pgid &&
  a.birthSeconds === b.birthSeconds && a.birthMicros === b.birthMicros;

/** Actual finite event transitions, shared by the transport and synthetic
 * tests. Parsing merely produces data. Authentication belongs to the captured
 * channel and root-selected process, not this reducer or its input hashes. */
export class DarwinAttemptOwnerEvents {
  #hello: DarwinAttemptOwnerEvent | undefined;
  #last: DarwinAttemptOwnerEvent | undefined;
  #preexec: DarwinAttemptOwnerEvent | undefined;
  #image: DarwinAttemptOwnerEvent | undefined;
  #exit: DarwinAttemptOwnerEvent | undefined;
  #streams: DarwinAttemptOwnerEvent | undefined;
  #lost = false;
  #released: DarwinAttemptOwnerEvent | undefined;
  #closedSequence: number | undefined;
  #first(event: DarwinAttemptOwnerEvent): void {
    if (event.kind !== "HELLO" || event.serial !== 1 || event.sequence !== 0 || event.phase !== native.phase.staged ||
        event.child !== undefined || event.preexecApplied || event.reaped || event.streamsSealed ||
        event.workspaceIno === "0") {throw new Error("native owner HELLO required");}
    this.#hello = event; this.#last = event;
  }
  #bindingMatches(event: DarwinAttemptOwnerEvent, hello: DarwinAttemptOwnerEvent): void {
    if (event.binding !== hello.binding || event.launch !== hello.launch || !sameBirth(event.owner, hello.owner) ||
        event.owner.dev !== hello.owner.dev || event.owner.ino !== hello.owner.ino ||
        event.workspaceDev !== hello.workspaceDev || event.workspaceIno !== hello.workspaceIno) {
      throw new Error("foreign native owner binding");
    }
  }
  #progress(event: DarwinAttemptOwnerEvent, last: DarwinAttemptOwnerEvent): void {
    if (event.kind === "HELLO" || event.serial !== last.serial + 1 || event.sequence < last.sequence ||
        event.sequence > last.sequence + 1 || event.revision < last.revision ||
        event.workspace < last.workspace || event.workspace > last.workspace + 1 || event.phase === native.phase.quarantined || event.result === native.result.unknown) {
      throw new Error("replayed or uncertain native owner event");
    }
    if ((last.cutoff && !event.cutoff) || (last.reaped && !event.reaped) ||
        (last.streamsSealed && !event.streamsSealed)) {throw new Error("native owner terminal observation regressed");}
  }
  #preexecEvent(event: DarwinAttemptOwnerEvent): void {
    if (this.#preexec || this.#exit || !event.preexecApplied || !event.child || event.imageIndex !== native.image.helper ||
        event.attestation === "0".repeat(64)) {throw new Error("invalid preexec acknowledgement");}
    this.#preexec = event;
  }
  #imageEvent(event: DarwinAttemptOwnerEvent): void {
    const child = this.#preexec?.child;
    if (!child || this.#image || this.#exit || !event.child || !sameBirth(child, event.child) ||
        !event.preexecApplied || !event.providerSeen || event.imageIndex !== native.image.provider ||
        event.attestation !== this.#preexec?.attestation) {throw new Error("provider did not exec-replace the retained child");}
    this.#image = event;
  }
  #exitEvent(event: DarwinAttemptOwnerEvent): void {
    if (this.#exit || !event.reaped || event.phase !== native.phase.exit || (event.exitCode === undefined && event.exitSignal === 0) ||
        (this.#image?.child && (!event.child || !sameBirth(this.#image.child, event.child)))) {
      throw new Error("invalid direct-child wait result");
    }
    this.#exit = event;
  }
  #streamsEvent(event: DarwinAttemptOwnerEvent): void {
    if (this.#streams || !event.streamsSealed || (!this.#exit && event.phase !== native.phase.noStart)) {
      throw new Error("streams sealed before authoritative writer cessation");
    }
    this.#streams = event;
  }
  #releaseEvent(event: DarwinAttemptOwnerEvent, last: DarwinAttemptOwnerEvent): void {
    if (this.#released || event.phase !== native.phase.released || last.phase !== native.phase.disposed || event.workspace !== native.workspace.closed ||
        !this.#streams || !event.streamsSealed || event.payload.length !== native.closedRecordBytes) {
      throw new Error("release without retained closed workspace and native stream settlement");
    }
    this.#released = event;
  }
  #checkClosedRead(event: DarwinAttemptOwnerEvent): void {
    if (!this.#released || event.command !== "READ_CLOSED_WORKSPACE" || !event.payload.equals(this.#released.payload)) {
      throw new Error("foreign closed read journal record");
    }
    this.#closedSequence = event.sequence;
  }
  accept(event: DarwinAttemptOwnerEvent): void {
    if (this.#lost) {throw new Error("native owner evidence is unknown");}
    if (this.#released && (!this.#last || event.sequence !== (this.#closedSequence ?? this.#released.sequence) + 1 ||
        !["TREE_ENTRY", "TREE_CHUNK", "TREE_END", "CLOSED_READ"].includes(event.kind))) {
      this.#lost = true; throw new Error("only a fresh bounded closed read may follow release");
    }
    try {
      if (this.#hello === undefined) {this.#first(event); return;}
      const last = this.#last;
      if (!last) {throw new Error("missing native owner predecessor");}
      this.#bindingMatches(event, this.#hello);
      this.#progress(event, last);
      switch (event.kind) {
        case "PREEXEC": this.#preexecEvent(event); break;
        case "IMAGE": this.#imageEvent(event); break;
        case "EXIT": this.#exitEvent(event); break;
        case "STREAMS": this.#streamsEvent(event); break;
        case "RELEASED": this.#releaseEvent(event, last); break;
        case "CLOSED_READ":
          this.#checkClosedRead(event); break;
        case "STDOUT": case "STDERR":
          if (this.#streams) {throw new Error("output after native stream settlement");}
          break;
        default: break;
      }
      this.#last = event;
    } catch (error) {this.#lost = true; throw error;}
  }
  lost(): void {this.#lost = true;}
  retainedClosed(): DarwinAttemptOwnerEvent | undefined {
    if (this.#lost || !this.#released) {return undefined;}
    return Object.freeze({ ...this.#released, payload: Buffer.from(this.#released.payload) });
  }
  capturedOwner(): DarwinAttemptOwnerEvent["owner"] {
    if (!this.#hello || this.#lost) {throw new Error("captured native owner unavailable");}
    return Object.freeze({ ...this.#hello.owner });
  }
  capturedPeerPacket(): Buffer {
    if (!this.#hello || this.#lost) {throw new Error("captured native owner unavailable");}
    const owner = this.#hello.owner, packet = Buffer.alloc(8272);
    packet.writeUInt32BE(owner.pid, 0); packet.writeUInt32BE(owner.ppid, 4);
    packet.writeUInt32BE(owner.pgid, 8); packet.writeUInt32BE(native.image.helper, 12);
    packet.writeBigUInt64BE(BigInt(owner.birthSeconds), 16); packet.writeBigUInt64BE(BigInt(owner.birthMicros), 24);
    packet.writeBigUInt64BE(BigInt(owner.dev), 32); packet.writeBigUInt64BE(BigInt(owner.ino), 40);
    this.#hello.payload.subarray(8232, 8264).copy(packet, 48);
    this.#hello.payload.subarray(40, 8232).copy(packet, 80);
    return packet;
  }
  capturedManifest(): Buffer {
    if (!this.#hello || this.#lost) {throw new Error("captured root manifest unavailable");}
    return Buffer.from(this.#hello.payload.subarray(40, 8232));
  }
  binding(): DarwinAttemptRetainedCompletion {
    const hello = this.#hello;
    if (!hello || this.#lost) {throw new Error("native owner binding unavailable");}
    return Object.freeze({ binding: hello.binding, launch: hello.launch, namespace: hello.payload.subarray(0, 40).toString("ascii"),
      workspaceDev: hello.workspaceDev, workspaceIno: hello.workspaceIno });
  }
  execution(): Readonly<{ exit: DarwinAttemptOwnerEvent; streams: DarwinAttemptOwnerEvent }> | undefined {
    if (this.#lost || !this.#preexec || !this.#image || !this.#exit || !this.#streams) {return undefined;}
    return Object.freeze({ exit: this.#exit, streams: this.#streams });
  }
}
interface Pending {
  readonly command: DarwinAttemptOwnerCommand;
  readonly sequence: number;
  readonly resolve: (event: DarwinAttemptOwnerEvent) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** Internal transport for the new root-launched Host executable only. The root
 * integrator owns passing the inherited endpoint and selected owner instances;
 * no production caller is wired to this factory in this patch. */
type NativeRequest = (command: DarwinAttemptOwnerCommand, argument?: number, payload?: Buffer) => Promise<DarwinAttemptOwnerEvent>;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const installMaterialData = async (request: NativeRequest, generation: (event: DarwinAttemptOwnerEvent) => number, input: Readonly<{config: Uint8Array; catalog: Uint8Array; installationId: string}>) => {
  const configInput = input.config, catalogInput = input.catalog, installationId = input.installationId;
  if (!(configInput instanceof Uint8Array) || !(catalogInput instanceof Uint8Array) ||
      !configInput.byteLength || configInput.byteLength > 65536 || catalogInput.byteLength !== 515145 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(installationId)) {
    throw new Error("invalid fixed native material input");
  }
  const config = Buffer.from(configInput), catalog = Buffer.from(catalogInput);
  const hashes = [digest(config), digest(catalog), digest(Buffer.from(installationId))];
  if (hashes[1] !== "d7136a413cfac1b5b1686d9e0dcc5c80ca05bebed5e9fc3911376561d0ef6ee8") {
    throw new Error("native catalog differs from pinned recipe");
  }
  const begin = Buffer.alloc(44); begin.writeUInt32BE(config.length); begin.writeUInt32BE(catalog.length, 4); begin.write(installationId, 8);
  await request("MATERIAL_BEGIN", begin.length, begin);
  for (const [index, bytes] of [config, catalog].entries()) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const chunk = bytes.subarray(offset, offset + 16384), payload = Buffer.alloc(8 + chunk.length);
      payload.writeUInt32BE(index); payload.writeUInt32BE(offset, 4); chunk.copy(payload, 8);
      await request("MATERIAL_CHUNK", payload.length, payload);
    }
  }
  const event = await request("MATERIAL_FINISH");
  const facts = decodeDarwinNativeMaterialData(event);
  for (const [index, file] of [facts.config, facts.catalog, facts.installation].entries()) {
    if (file.sha256 !== hashes[index]) {throw new Error("native material readback differs from immutable source");}
  }
  if (facts.config.bytes !== config.length || facts.catalog.bytes !== catalog.length) {throw new Error("native material readback size mismatch");}
  return Object.freeze({facts, installationId, generation: generation(event)});
};
const sendTreeSnapshot = async (request: NativeRequest, snapshot: ReturnType<typeof captureDarwinWorkspaceTree>, limits: DarwinNativeWorkspaceTreeLimits): Promise<void> => {
  const begin = Buffer.alloc(16);
  [limits.maxDepth, limits.maxEntries, limits.maxFileBytes, limits.maxTotalBytes].forEach((value, index) => begin.writeUInt32BE(value, index * 4));
  await request("MATERIALIZE_BEGIN", begin.length, begin);
  const ordinals = new Map<string, number>();
  const files = new Map(snapshot.files.map(file => [file.relativePath, file]));
  for (const [ordinal, entry] of snapshot.entries.entries()) {
    const parts = entry.relativePath.split("/"), name = Buffer.from(parts.pop()!, "utf8"), parent = parts.join("/");
    const payload = Buffer.alloc(24 + name.length);
    payload.writeUInt32BE(ordinal, 0); payload.writeUInt32BE(parent === "" ? 0xffff_ffff : ordinals.get(parent)!, 4);
    payload.writeUInt32BE(Number(entry.kind === "directory"), 8); payload.writeUInt32BE(entry.mode, 12);
    payload.writeUInt32BE(entry.kind === "file" ? entry.size : 0, 16); payload.writeUInt32BE(name.length, 20); name.copy(payload, 24);
    await request("MATERIALIZE_ENTRY", payload.length, payload); ordinals.set(entry.relativePath, ordinal);
    const file = files.get(entry.relativePath);
    if (file) {
      for (let offset = 0; offset < file.size; offset += 16384) {
        const bytes = file.bytes.subarray(offset, offset + 16384), chunk = Buffer.alloc(8 + bytes.length);
        chunk.writeUInt32BE(ordinal, 0); chunk.writeUInt32BE(offset, 4); bytes.copy(chunk, 8);
        await request("MATERIALIZE_CHUNK", chunk.length, chunk);
      }
    }
  }
  await request("MATERIALIZE_FINISH");
};
const creationPayload = (treeDigest: string, operationId: string, scope: {tenantId: string; projectId: string}): Buffer => {
  if (!/^[a-f0-9]{64}$/u.test(treeDigest)) {throw new Error("invalid native creation digest");}
  const payload = Buffer.alloc(3116);
  Buffer.from(treeDigest, "hex").copy(payload);
  for (const [index, value] of [operationId, scope.tenantId, scope.projectId].entries()) {
    const bytes = Buffer.from(value, "utf8");
    if (!bytes.length || bytes.length > 1024 || bytes.includes(0)) {throw new Error("invalid creation scope");}
    payload.writeUInt32BE(bytes.length, 32 + index * 1028);
    bytes.copy(payload, 36 + index * 1028);
  }
  return payload;
};
const makeMaterializer = (request: NativeRequest, readCompleteTree: () => Promise<DarwinNativeWorkspaceTree>,
  retainLimits: (limits: DarwinNativeWorkspaceTreeLimits) => void, lose: (error: unknown) => void) => {
  let materializationConsumed = false;
  return async (source: DarwinNativeWorkspaceTree, limits: DarwinNativeWorkspaceTreeLimits): Promise<DarwinNativeWorkspaceTree> => {
    if (materializationConsumed) {throw new Error("native materialization already consumed");}
    materializationConsumed = true;
    try {
      const snapshot = captureDarwinWorkspaceTree(source, limits);
      retainLimits(Object.freeze({ ...limits }));
      await sendTreeSnapshot(request, snapshot, limits);
      const destination = await readCompleteTree();
      if (destination.treeDigest !== snapshot.treeDigest) {throw new Error("native destination differs from canonical source");}
      return destination;
    } catch (error) {lose(error); throw error;}
  };
};
const pumpOwnerEvents = async (endpoint: Duplex, reader: DarwinAttemptOwnerEventReader,
  receive: (event: DarwinAttemptOwnerEvent) => Promise<void>, lose: (error: unknown) => void): Promise<void> => {

  try {
    for await (const chunk of endpoint) {
      if (!(chunk instanceof Uint8Array)) {throw new Error("native owner transport must carry bytes");}
      for (const event of reader.push(chunk)) {await receive(event);}
    }
    reader.end();
    throw new Error("native helper transport ended; this is not ProviderExit or StreamSealed");
  } catch (error) {lose(error);}
};
const observationEnds = (event: DarwinAttemptOwnerEvent): boolean =>
  event.cutoff || ["EXIT", "RELEASED"].includes(event.kind);
function assertReservable(failed: Error | undefined, closed: boolean, started: boolean, creation: boolean, directories: boolean): void {
  if (failed || closed || started || !creation || !directories) {
    throw new Error("native execution reservation requires current directories and acknowledged creation");
  }
}
function nativeResponseEpochs() {
  const captured = new WeakMap<DarwinAttemptOwnerEvent, number>();
  return Object.freeze({
    accept: (event: DarwinAttemptOwnerEvent, generation: number): void => {captured.set(event, generation);},
    get(event: DarwinAttemptOwnerEvent): number {
      const generation = captured.get(event);
      if (generation === undefined) {throw new Error("native response epoch unavailable");}
      return generation;
    },
  });
}
async function installObservedMaterial(
  request: NativeRequest, generation: (event: DarwinAttemptOwnerEvent) => number,
  directories: ReturnType<typeof retainNativeDirectories>,
  input: Readonly<{config: Uint8Array; catalog: Uint8Array; installationId: string}>,
) {
  const captured = await installMaterialData(request, generation, input);
  const observation = directories.retain(captured.facts.observation);
  return Object.freeze({...captured, facts: Object.freeze({...captured.facts, observation})});
}
function retainNativeDirectories() {
  let originalDirectories: DarwinNativeLaunchData | undefined;
  const retain = (facts: DarwinNativeLaunchData): DarwinNativeLaunchData => {
    const original = originalDirectories;
    if (original) {
      if (facts.operationId !== original.operationId || facts.leasedUid !== original.leasedUid ||
          (["privateRoot", "codexHome", "tmpDir", "workspace"] as const).some(key => {
            const before = original[key], after = facts[key];
            return before.path !== after.path || before.dev !== after.dev || before.ino !== after.ino ||
              before.uid !== after.uid || before.mode !== after.mode;
          })) {throw new Error("native directory identity changed within retained epoch");}
      return original;
    }
    originalDirectories = facts;
    return facts;
  };
  return Object.freeze({retain, current: () => originalDirectories, present: () => originalDirectories !== undefined});
}

function finalLaunchCapture(request: NativeRequest, current: () => boolean, lose: (error: unknown) => void) {
  let consumed = false;
  return async (input: DarwinNativeFinalLaunchData): Promise<void> => {
    if (consumed) {throw new Error("native final launch already consumed");}
    consumed = true;
    try {
      const bytes = encodeDarwinNativeFinalLaunchData(input);
      await request("BIND_FINAL_LAUNCH", bytes.length, bytes);
      if (!current()) {throw new Error("native final launch became unavailable");}
    } catch (error) {lose(error); throw error;}
  };
}
function nativeCreationCommit(request: NativeRequest, acknowledge: () => void) {
  return async (treeDigest: string, operationId: string, scope: {tenantId: string; projectId: string}) => {
    const payload = creationPayload(treeDigest, operationId, scope);
    const observed = await request("COMMIT_CREATION", payload.length, payload);
    acknowledge(); return observed;
  };
}
function nativeProcessStart({request, directories, events, execution, input, current}: {
  request: NativeRequest; directories: ReturnType<typeof retainNativeDirectories>;
  events: DarwinAttemptOwnerEvents; execution: ReturnType<typeof nativeExecution>;
  input: ReturnType<typeof nativeInput>; current: () => boolean;
}) {
  return async (): Promise<CustodiedProviderProcess> => {
    const facts = directories.current();
    if (!facts) {throw new Error("native process lacks retained directory observation");}
    const binding = events.binding();
    await request("START_ONCE");
    await execution.image;
    if (!current()) {throw new Error("native process lost during start");}
    return Object.freeze({custodyRef: binding.binding, workspaceAuthorityPath: facts.workspace.path,
      stdout: execution.stdout, stderr: execution.stderr, write: input.writeInput, closeInput: input.closeInput,
      waitForExit: () => execution.exit});
  };
}
export function bindDarwinAttemptOwnerBridge(endpoint: Duplex, selected: DarwinAttemptRetainedOwners) {
  const owners = Object.freeze({ launchRoute: selected.launchRoute, artifactResult: selected.artifactResult,
    workspace: selected.workspace, privateMaterial: selected.privateMaterial, output: selected.output });
  const events = new DarwinAttemptOwnerEvents();
  const execution = nativeExecution();
  const reader = new DarwinAttemptOwnerEventReader();
  let pending: Pending | undefined;
  let treeReceiver: DarwinWorkspaceTreeReceiver | undefined;
  let treeLimits: DarwinNativeWorkspaceTreeLimits | undefined;
  let sequence = 0;
  let admissionClosed = false;
  let startConsumed = false;
  let inFlight: Promise<DarwinAttemptOwnerEvent> | undefined;
  let failed: Error | undefined;
  let initial: (() => void) | undefined;
  let rejectInitial: ((reason: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {initial = resolve; rejectInitial = reject;});
  const helloTimer = setTimeout(() => lose(new Error("native owner HELLO timed out; no retry")), 6000);
  void ready.then(() => clearTimeout(helloTimer), () => clearTimeout(helloTimer));
  // The trusted Host may finish constructing its retained owners before await.
  void ready.catch(() => {});
  const lose = (cause: unknown): void => {
    if (failed) {return;}
    failed = cause instanceof Error ? cause : new Error("native owner channel lost");
    events.lost(); execution.lost(failed); rejectInitial?.(failed);
    if (pending) {clearTimeout(pending.timer); pending.reject(failed); pending = undefined;}
    endpoint.destroy();
  };
  let observationGeneration = 0; const responseEpochs = nativeResponseEpochs();
  const directories = retainNativeDirectories();
  let materialConsumed = false, creationAcknowledged = false;
  const receive = async (event: DarwinAttemptOwnerEvent): Promise<void> => {
    events.accept(event);
    execution.accept(event);
    observationGeneration += Number(observationEnds(event));
    if (event.kind === "HELLO") {initial?.(); initial = undefined; rejectInitial = undefined; return;}
    if (event.kind === "TREE_ENTRY" || event.kind === "TREE_CHUNK" || event.kind === "TREE_END") {
      if (!treeReceiver || !["READ_TREE", "READ_CLOSED_WORKSPACE", "QUERY_CLOSED_WORKSPACE"].includes(pending?.command ?? "") || event.sequence !== pending?.sequence) {
        throw new Error("unsolicited native tree observation");
      }
      treeReceiver.accept(event); return;
    }
    if (["STDOUT", "STDERR"].includes(event.kind)) {
      await owners.output(event.kind === "STDOUT" ? "stdout" : "stderr", Buffer.from(event.payload));
    }
    if (event.command === undefined) {return;}
    if (!pending || event.sequence !== pending.sequence || event.command !== pending.command) {
      throw new Error("unsolicited or mismatched native response");
    }
    const completing = pending; pending = undefined; clearTimeout(completing.timer);
    responseEpochs.accept(event, observationGeneration);
    if (event.kind === "REFUSED" || event.result !== native.result.accepted) {completing.reject(new Error("native owner refused command"));}
    else {completing.resolve(event);}
  };
  void pumpOwnerEvents(endpoint, reader, receive, lose);
  const request = async (command: DarwinAttemptOwnerCommand, argument = 0, payload: Buffer = Buffer.alloc(0)): Promise<DarwinAttemptOwnerEvent> => {
    // Same-inode preparation/materialization and START do not revoke directory identity.
    // Destructive/terminal effects revoke before transport, including uncertainty.
    observationGeneration += Number(["CUTOFF", "WORKSPACE_FREEZE", "WORKSPACE_CLEANUP", "WORKSPACE_CLOSE", "DISPOSE_ONCE"].includes(command));
    await ready;
    if (failed) {throw failed;}
    if (command === "START_ONCE" && (admissionClosed || startConsumed)) {throw new Error("Host start admission already consumed or cut off");}
    if (pending || sequence === 0xffff_ffff) {throw new Error("owner command concurrent or sequence exhausted");}
    const binding = events.binding();
    const frame = encodeDarwinAttemptOwnerRequest({ command, argument, sequence: ++sequence, binding: binding.binding, launch: binding.launch });
    if (command === "START_ONCE") {startConsumed = true;}
    const result = new Promise<DarwinAttemptOwnerEvent>((resolve, reject) => {
      const timer = setTimeout(() => lose(new Error("native owner acknowledgement timed out; no retry")), 6000);
      pending = { command, sequence, resolve, reject, timer };
      try {endpoint.write(Buffer.concat([frame, payload]), (error: Error | null | undefined) => {if (error) {lose(error);}});}
      catch (error) {lose(error);}
    });
    inFlight = result;
    const settled = (): void => {if (inFlight === result) {inFlight = undefined;}};
    void result.then(settled, settled);
    return result;
  };
  const cutoff = async (): Promise<DarwinAttemptOwnerEvent> => {
    admissionClosed = true; // Latch synchronously, including before HELLO/ready.
    if (inFlight) {await inFlight;}
    return request("CUTOFF");
  };
  const settle = async (callback: () => Promise<DarwinAttemptRetainedCompletion>, command: DarwinAttemptOwnerCommand): Promise<void> => {
    await ready;
    const expected = events.binding();
    // Only the root-selected retained capability is called; no externally
    // supplied receipt, completion object or trusted flag is accepted here.
    const actual = await callback();
    if (actual.binding !== expected.binding || actual.launch !== expected.launch || actual.namespace !== expected.namespace ||
        actual.workspaceDev !== expected.workspaceDev || actual.workspaceIno !== expected.workspaceIno) {
      lose(new Error("retained consumer completed for a foreign owner"));
      throw failed;
    }
    await request(command);
  };
  const readCompleteTree = async (command: "READ_TREE" | "QUERY_CLOSED_WORKSPACE" = "READ_TREE"): Promise<DarwinNativeWorkspaceTree> => {
    if (!treeLimits || treeReceiver) {throw new Error("native tree transaction unavailable or concurrent");}
    const binding = events.binding();
    const receiver = new DarwinWorkspaceTreeReceiver(treeLimits, binding.workspaceDev, binding.workspaceIno);
    treeReceiver = receiver;
    try {await request(command); return receiver.finish();}
    catch (error) {lose(error); throw error;}
    finally {treeReceiver = undefined;}
  };
  const materializeComplete = makeMaterializer(request, readCompleteTree, limits => {treeLimits = limits;}, lose);
  const inputTransport = nativeInput(request, () => startConsumed && !failed && !admissionClosed, lose);
  const startProcess = nativeProcessStart({request, directories, events, execution, input: inputTransport, current: () => !failed && !admissionClosed});
  return Object.freeze({
    ready, materializeComplete, readCompleteTree: () => readCompleteTree(), queryClosedWorkspace: () => readCompleteTree("QUERY_CLOSED_WORKSPACE"),
    revokeAdmission: (): void => {admissionClosed = true; observationGeneration++;},
    ...inputTransport, startProcess,
    captureFinalLaunch: finalLaunchCapture(request, () => !failed && !admissionClosed, lose),
    async installCodexMaterial(input: Readonly<{config: Uint8Array; catalog: Uint8Array; installationId: string}>) {
      if (materialConsumed) {throw new Error("native material installation already consumed");}
      materialConsumed = true; // Burn and snapshot before the first await.
      try {
        return await installObservedMaterial(request, responseEpochs.get, directories, input);
      } catch (error) {lose(error); throw error;}
    },
    async readLaunchObservation() {
      const event = await request("READ_OBSERVATION");
      try {return Object.freeze({facts: directories.retain(decodeDarwinNativeLaunchData(event)), generation: responseEpochs.get(event)});}
      catch (error) {lose(error); throw error;}
    },
    assertObservationCurrent: (generation: number): void => {
      if (failed || admissionClosed || generation !== observationGeneration) {throw new Error("native observation is no longer current");}
    },
    assertExecutionReservable: (): void => assertReservable(failed, admissionClosed, startConsumed, creationAcknowledged, directories.present()),
    bindPreparedData: (bytes: Buffer) => request("BIND_PREPARED", bytes.length, bytes),
    confirmClaimData: (bytes: Buffer) => request("CONFIRM_CLAIM", bytes.length, bytes),
    commitCreation: nativeCreationCommit(request, () => {creationAcknowledged = true;}),
    binding: () => events.binding(), capturedManifest: () => events.capturedManifest(), capturedOwner: () => events.capturedOwner(), capturedPeerPacket: () => events.capturedPeerPacket(),
    start: () => request("START_ONCE"), cutoff, status: () => request("READ_STATUS"),
    execution: () => events.execution(), retainedClosed: () => events.retainedClosed(),
    freezeWorkspace: () => request("WORKSPACE_FREEZE"), cleanupWorkspace: () => request("WORKSPACE_CLEANUP"),
    closeWorkspace: () => request("WORKSPACE_CLOSE"),
    async readClosedWorkspace() {
      const known = events.retainedClosed();
      if (!known || !treeLimits || treeReceiver) {throw new Error("genuine native closed-read grant unavailable");}
      const receiver = new DarwinWorkspaceTreeReceiver(treeLimits, known.workspaceDev, known.workspaceIno);
      treeReceiver = receiver;
      try {
        const event = await request("READ_CLOSED_WORKSPACE");
        return Object.freeze({ event, tree: receiver.finish() });
      } catch (error) {lose(error); throw error;}
      finally {treeReceiver = undefined;}
    },
    settleLaunchRoute: () => settle(owners.launchRoute, "SETTLE_LAUNCH_ROUTE"),
    settleArtifactResult: () => settle(owners.artifactResult, "SETTLE_ARTIFACT_RESULT"),
    settleWorkspace: () => settle(owners.workspace, "SETTLE_WORKSPACE"),
    settlePrivateMaterial: () => settle(owners.privateMaterial, "SETTLE_PRIVATE"),
    disposePrivate: () => request("DISPOSE_ONCE"),
    lost: () => lose(new Error("Host relinquished channel without consumer settlement")),
  });
}
