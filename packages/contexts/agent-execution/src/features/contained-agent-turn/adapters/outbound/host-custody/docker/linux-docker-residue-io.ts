import {constants} from "node:fs";
import {open, opendir, statfs, type FileHandle} from "node:fs/promises";
import type {DockerEngineCall} from "./engine/docker-engine-port.js";
import {residueComponent, residueFault} from "./linux-docker-residue-parsers.js";

export const PROC_SUPER_MAGIC = 0x9fa0n;
export const CGROUP2_SUPER_MAGIC = 0x63677270n;
export interface ResidueFile {readonly fd: number;}
export interface ResidueStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly directory: boolean;
  readonly file: boolean;
}
/** Docker-private kernel I/O seam. Production never accepts a backend argument. */
export interface DockerResidueIo {
  open(path: "/" | "/proc"): Promise<ResidueFile>;
  procObject?(process: ResidueFile, name: "root" | "ns/mnt"): Promise<ResidueFile>;
  mountId?(file: ResidueFile): Promise<string>;
  child(parent: ResidueFile, name: string, directory: boolean): Promise<ResidueFile>;
  stat(file: ResidueFile): Promise<ResidueStat>;
  filesystem(file: ResidueFile): Promise<bigint>;
  read(file: ResidueFile, maxBytes: number): Promise<string>;
  directories(file: ResidueFile): Promise<readonly string[]>;
  close(file: ResidueFile): Promise<void>;
}

/** Only reads protected kernel files. No cgroup write, migration or process signal. */
export class NodeLinuxDockerResidueIo implements DockerResidueIo {
  private path(file: ResidueFile): string {return `/proc/${process.pid}/fd/${file.fd}`;}
  public async open(path: "/" | "/proc"): Promise<FileHandle> {
    if (process.platform !== "linux") {throw residueFault();}
    return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  /** The only followed magic links are rooted at an already pinned proc PID. */
  public async procObject(process: ResidueFile, name: "root" | "ns/mnt"): Promise<FileHandle> {
    if (name !== "root" && name !== "ns/mnt") {throw residueFault();}
    return open(`${this.path(process)}/${name}`, constants.O_RDONLY | constants.O_NONBLOCK |
      (name === "root" ? constants.O_DIRECTORY : 0));
  }
  public async mountId(file: ResidueFile): Promise<string> {
    const info = await open(`/proc/${process.pid}/fdinfo/${file.fd}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await this.read(info, 4096);
      const ids = [...text.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
      if (ids.length !== 1) {throw residueFault();}
      return ids[0]![1]!;
    } finally {await info.close();}
  }
  public async child(parent: ResidueFile, name: string, directory: boolean): Promise<FileHandle> {
    if (!residueComponent(name)) {throw residueFault();}
    return open(`${this.path(parent)}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW |
      constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
  }
  public async stat(file: ResidueFile): Promise<ResidueStat> {
    const facts = await (file as FileHandle).stat({bigint: true});
    return {dev: facts.dev, ino: facts.ino, nlink: facts.nlink, uid: Number(facts.uid), gid: Number(facts.gid),
      mode: Number(facts.mode & 0o7777n), directory: facts.isDirectory(), file: facts.isFile()};
  }
  public async filesystem(file: ResidueFile): Promise<bigint> {
    return (await statfs(this.path(file), {bigint: true})).type;
  }
  public async read(file: ResidueFile, maxBytes: number): Promise<string> {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const result = await (file as FileHandle).read(buffer, length, buffer.length - length, length);
      length += result.bytesRead;
      if (length > maxBytes) {throw residueFault();}
      if (result.bytesRead === 0) {break;}
    }
    // Mount names may contain UTF-8; individual fact parsers still require exact
    // kernel syntax. NUL and replacement decoding are never accepted.
    if (buffer.subarray(0, length).includes(0)) {throw residueFault();}
    return new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, length));
  }
  public async directories(file: ResidueFile): Promise<readonly string[]> {
    const directory = await opendir(this.path(file), {bufferSize: 16});
    const names: string[] = [];
    let count = 0;
    try {
      for (;;) {
        const entry = await directory.read();
        if (entry === null) {break;}
        count += 1;
        if (count > 128 || !residueComponent(entry.name) || entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())) {throw residueFault();}
        if (entry.isDirectory()) {names.push(entry.name);}
      }
      return names.toSorted();
    } finally {await directory.close();}
  }
  public async close(file: ResidueFile): Promise<void> {await (file as FileHandle).close();}
}

export interface ResiduePin {readonly file: ResidueFile; readonly facts: ResidueStat; readonly filesystem: bigint;}
export const sameResidueInode = (left: ResidueStat, right: ResidueStat): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid &&
  left.mode === right.mode && right.nlink > 0n;

/** The operation owns late opens until settled. Cancellation never closes an FD
 * under an outstanding read or allows a delayed result to publish a new pin. */
export class ResidueIoScope {
  public readonly files = new Set<ResidueFile>();
  public cancelled = false;
  public constructor(public readonly io: DockerResidueIo, private readonly call: DockerEngineCall) {}
  public check(): void {
    if (this.cancelled || this.call.signal.aborted || !Number.isSafeInteger(this.call.deadlineEpochMs) ||
        Date.now() >= this.call.deadlineEpochMs) {throw residueFault();}
  }
  public async acquire(work: () => Promise<ResidueFile>): Promise<ResidueFile> {
    this.check();
    if (this.files.size >= 256) {throw residueFault();}
    const file = await work();
    this.files.add(file);
    this.check();
    return file;
  }
  public async protect(file: ResidueFile, directory: boolean, uid = 0): Promise<ResiduePin> {
    this.check();
    const facts = await this.io.stat(file);
    const filesystem = await this.io.filesystem(file);
    this.check();
    if (facts.uid !== uid || (uid === 0 && facts.gid !== 0) || (facts.mode & 0o7022) !== 0 ||
        facts.nlink === 0n || (directory ? !facts.directory : !facts.file)) {throw residueFault();}
    return {file, facts, filesystem};
  }
  public async child(parent: ResiduePin, name: string, directory: boolean, uid = 0): Promise<ResiduePin> {
    const file = await this.acquire(() => this.io.child(parent.file, name, directory));
    const pin = await this.protect(file, directory, uid);
    if (pin.filesystem !== parent.filesystem || pin.facts.dev !== parent.facts.dev) {throw residueFault();}
    return pin;
  }
  public async text(pin: ResiduePin, maxBytes: number): Promise<string> {
    await this.verify(pin);
    const text = await this.io.read(pin.file, maxBytes);
    this.check();
    if (Buffer.byteLength(text) > maxBytes) {throw residueFault();}
    await this.verify(pin);
    return text;
  }
  public async verify(pin: ResiduePin): Promise<void> {
    this.check();
    if (!sameResidueInode(pin.facts, await this.io.stat(pin.file)) ||
        pin.filesystem !== await this.io.filesystem(pin.file)) {throw residueFault();}
    this.check();
  }
  public async release(file: ResidueFile): Promise<void> {
    await this.io.close(file);
    this.files.delete(file);
  }
  public async close(): Promise<void> {
    for (const file of this.files) {await this.release(file);}
  }
}

export const boundResidueWork = async <T>(work: Promise<T>, call: DockerEngineCall, cancel: () => void): Promise<T> => {
  const remaining = Math.min(10_000, call.deadlineEpochMs - Date.now());
  return new Promise<T>((resolve, reject) => {
    const fail = (): void => {cancel(); cleanup(); reject(residueFault());};
    const timer = setTimeout(fail, Math.max(1, remaining));
    const cleanup = (): void => {clearTimeout(timer); call.signal.removeEventListener("abort", fail);};
    call.signal.addEventListener("abort", fail, {once: true});
    void work.then(value => {cleanup(); resolve(value); return;}, error => {cleanup(); reject(error);});
    if (call.signal.aborted || !Number.isSafeInteger(call.deadlineEpochMs) || remaining <= 0) {fail();}
  });
};
