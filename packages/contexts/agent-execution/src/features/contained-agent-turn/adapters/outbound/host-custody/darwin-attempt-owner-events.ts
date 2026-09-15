type DarwinAttemptOwnerBinding = Readonly<{
  readonly binding: string;
  readonly launch: string;
  readonly namespace: string;
  readonly workspaceDev: string;
  readonly workspaceIno: string;
}>;
import {darwinAttemptOwnerStates as native, type DarwinAttemptOwnerEvent} from "./darwin-attempt-owner-protocol.js";
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
  #acceptEvent(event: DarwinAttemptOwnerEvent, last: DarwinAttemptOwnerEvent): void {
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
      case "HELLO":
      case "MATERIAL_RESULT":
      case "OBSERVATION":
      case "REFUSED":
      case "STATUS":
      case "TREE_CHUNK":
      case "TREE_END":
      case "TREE_ENTRY":
      default: break;
    }
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
      this.#acceptEvent(event, last);
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
  binding(): DarwinAttemptOwnerBinding {
    const hello = this.#hello;
    if (!hello || this.#lost) {throw new Error("native owner binding unavailable");}
    return Object.freeze({ binding: hello.binding, launch: hello.launch, namespace: hello.payload.subarray(0, 40).toString("ascii"),
      workspaceDev: hello.workspaceDev, workspaceIno: hello.workspaceIno });
  }
  execution(): Readonly<{ image: DarwinAttemptOwnerEvent; exit: DarwinAttemptOwnerEvent; streams: DarwinAttemptOwnerEvent }> | undefined {
    if (this.#lost || !this.#preexec || !this.#image || !this.#exit || !this.#streams) {return undefined;}
    return Object.freeze({ image: this.#image, exit: this.#exit, streams: this.#streams });
  }
  image(): DarwinAttemptOwnerEvent | undefined {
    if (this.#lost || !this.#preexec || !this.#image) {return undefined;}
    return this.#image;
  }
  noStart(): DarwinAttemptOwnerEvent | undefined {
    if (this.#lost || this.#preexec || this.#image || this.#exit || this.#streams?.phase !== native.phase.noStart) {return undefined;}
    return this.#streams;
  }
}
