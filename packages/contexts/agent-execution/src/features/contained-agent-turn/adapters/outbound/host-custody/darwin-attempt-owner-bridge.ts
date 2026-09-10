import type { Duplex } from "node:stream";
import {
  DarwinAttemptOwnerEventReader, encodeDarwinAttemptOwnerRequest, darwinAttemptOwnerStates as native,
  type DarwinAttemptOwnerCommand, type DarwinAttemptOwnerEvent,
} from "./darwin-attempt-owner-protocol.ts";

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
  accept(event: DarwinAttemptOwnerEvent): void {
    if (this.#lost || this.#released) {throw new Error("native owner evidence is unknown or already released");}
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
  capturedManifest(): Buffer {
    if (!this.#hello || this.#lost) {throw new Error("captured root manifest unavailable");}
    return Buffer.from(this.#hello.payload.subarray(40));
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
export function bindDarwinAttemptOwnerBridge(endpoint: Duplex, selected: DarwinAttemptRetainedOwners) {
  const owners = Object.freeze({ launchRoute: selected.launchRoute, artifactResult: selected.artifactResult,
    workspace: selected.workspace, privateMaterial: selected.privateMaterial, output: selected.output });
  const events = new DarwinAttemptOwnerEvents();
  const reader = new DarwinAttemptOwnerEventReader();
  let pending: Pending | undefined;
  let sequence = 0;
  let admissionClosed = false;
  let startConsumed = false;
  let inFlight: Promise<DarwinAttemptOwnerEvent> | undefined;
  let failed: Error | undefined;
  let initial: (() => void) | undefined;
  let rejectInitial: ((reason: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {initial = resolve; rejectInitial = reject;});
  // The trusted Host may finish constructing its retained owners before await.
  void ready.catch(() => {});
  const lose = (cause: unknown): void => {
    if (failed) {return;}
    failed = cause instanceof Error ? cause : new Error("native owner channel lost");
    events.lost(); rejectInitial?.(failed);
    if (pending) {clearTimeout(pending.timer); pending.reject(failed); pending = undefined;}
    endpoint.destroy();
  };
  const receive = async (event: DarwinAttemptOwnerEvent): Promise<void> => {
    events.accept(event);
    if (event.kind === "HELLO") {initial?.(); initial = undefined; rejectInitial = undefined; return;}
    if (event.kind === "STDOUT" || event.kind === "STDERR") {
      await owners.output(event.kind === "STDOUT" ? "stdout" : "stderr", Buffer.from(event.payload));
    }
    if (event.command === undefined) {return;}
    if (!pending || event.sequence !== pending.sequence || event.command !== pending.command) {
      throw new Error("unsolicited or mismatched native response");
    }
    const completing = pending; pending = undefined; clearTimeout(completing.timer);
    if (event.kind === "REFUSED" || event.result !== native.result.accepted) {completing.reject(new Error("native owner refused command"));}
    else {completing.resolve(event);}
  };
  const run = async (): Promise<void> => {
    try {
      for await (const chunk of endpoint) {
        if (!(chunk instanceof Uint8Array)) {throw new Error("native owner transport must carry bytes");}
        for (const event of reader.push(chunk)) {await receive(event);}
      }
      reader.end();
      if (events.retainedClosed() && !pending) {return;}
      throw new Error("native helper transport ended; this is not ProviderExit or StreamSealed");
    } catch (error) {lose(error);}
  };
  void run();
  const request = async (command: DarwinAttemptOwnerCommand, argument = 0): Promise<DarwinAttemptOwnerEvent> => {
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
      try {endpoint.write(frame, (error: Error | null | undefined) => {if (error) {lose(error);}});}
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
  return Object.freeze({
    ready, binding: () => events.binding(), capturedManifest: () => events.capturedManifest(),
    start: () => request("START_ONCE"), cutoff, status: () => request("READ_STATUS"),
    execution: () => events.execution(), retainedClosed: () => events.retainedClosed(),
    freezeWorkspace: () => request("WORKSPACE_FREEZE"), cleanupWorkspace: () => request("WORKSPACE_CLEANUP"),
    closeWorkspace: () => request("WORKSPACE_CLOSE"), readClosedWorkspace: () => request("READ_CLOSED_WORKSPACE"),
    readArtifactSlot: (slot: 0 | 1) => request("READ_ARTIFACT_SLOT", slot),
    settleLaunchRoute: () => settle(owners.launchRoute, "SETTLE_LAUNCH_ROUTE"),
    settleArtifactResult: () => settle(owners.artifactResult, "SETTLE_ARTIFACT_RESULT"),
    settleWorkspace: () => settle(owners.workspace, "SETTLE_WORKSPACE"),
    settlePrivateMaterial: () => settle(owners.privateMaterial, "SETTLE_PRIVATE"),
    disposePrivate: () => request("DISPOSE_ONCE"),
    lost: () => lose(new Error("Host relinquished channel without consumer settlement")),
  });
}
