import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, fsyncSync, writeSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody/composition";

export interface DarwinTrustedDirectory { readonly path: string; readonly dev: string; readonly ino: string }
const reject = (): never => {throw new Error("Darwin durable route storage unavailable; reconcile original locator");};
export const darwinDigest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 1_048_576;
const MAX_FRAME = 16_384;

/** Name-bound under the coordinator's protected Host namespace. No procfs,
 * descriptor-relative publication claim, stale-lock breaking or replay. */
export class DarwinRouteDurableStorage {
  readonly #root: DarwinTrustedDirectory;
  readonly #ancestors: readonly Readonly<{path: string; dev: bigint; ino: bigint; uid: bigint; mode: bigint}>[];
  readonly #files = new Map<string, {fd: number; dev: bigint; ino: bigint; size: number; sequence: number; tail: string}>();
  #directory: number | undefined;
  #release: (() => void) | undefined;
  #running: Promise<void> | undefined;
  #failed = false;
  #closed = false;
  #entered = false;
  public constructor(root: DarwinTrustedDirectory, public readonly locator: string) {
    this.#root = Object.freeze({...root});
    if (process.platform !== "darwin" || !/^[a-f0-9]{64}$/u.test(locator) ||
        resolve(root.path) !== root.path || realpathSync(root.path) !== root.path) {reject();}
    const ancestors = [];
    let path = root.path;
    for (;;) {
      const s = lstatSync(path, {bigint: true});
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022n) !== 0n ||
          (s.uid !== 0n && s.uid !== BigInt(process.getuid!()))) {reject();}
      ancestors.push(Object.freeze({path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode}));
      if (dirname(path) === path) {break;}
      path = dirname(path);
    }
    if (String(ancestors[0]!.dev) !== root.dev || String(ancestors[0]!.ino) !== root.ino) {reject();}
    this.#ancestors = Object.freeze(ancestors);
  }
  public get path(): string {return join(this.#root.path, `${this.locator}.darwin-lifecycle-v1`);}
  public assertIntact(): void {
    if (this.#failed || this.#closed) {reject();}
    for (const pin of this.#ancestors) {
      const s = lstatSync(pin.path, {bigint: true});
      if (!s.isDirectory() || s.dev !== pin.dev || s.ino !== pin.ino || s.mode !== pin.mode || s.uid !== pin.uid) {reject();}
    }
    if (this.#directory !== undefined) {
      const s = fstatSync(this.#directory, {bigint: true});
      if (!s.isDirectory() || String(s.dev) !== this.#root.dev || String(s.ino) !== this.#root.ino) {reject();}
    }
    this.#assertFiles();
  }
  #assertFiles(): void {
    for (const [name, file] of this.#files) {
      const path = lstatSync(this.#filePath(name), {bigint: true});
      const held = fstatSync(file.fd, {bigint: true});
      if (!path.isFile() || !held.isFile() || path.nlink !== 1n || held.nlink !== 1n ||
          path.dev !== file.dev || path.ino !== file.ino || held.dev !== file.dev || held.ino !== file.ino ||
          path.mode !== 0o100600n || held.mode !== path.mode || held.uid !== BigInt(process.getuid!()) ||
          held.size !== BigInt(file.size) || path.size !== held.size) {reject();}
    }
  }
  #filePath(name: string): string {
    if (name !== "lifecycle" && name !== "consumption") {return reject();}
    return join(this.#root.path, `${this.locator}.darwin-${name}-v1`);
  }
  public async open(): Promise<void> {
    if (this.#entered) {reject();}
    this.#entered = true;
    this.assertIntact();
    this.#directory = openSync(this.#root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    this.#release = release.resolve;
    this.#running = withStableDirectoryProcessLock({fd: this.#directory}, async () => {
      this.assertIntact();
      // Fixed names bound to operation, independent of generation. Any residue
      // requires external reconciliation; even a valid terminal log cannot replay.
      for (const name of ["lifecycle", "consumption"]) {
        try {lstatSync(this.#filePath(name));}
        catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") {continue;} throw error;}
        reject();
      }
      ready.resolve();
      await release.promise;
      this.assertIntact();
    }, {onContention: () => reject()}).catch(error => {
      this.#failed = true; ready.reject(error);
    }).finally(() => {
      for (const file of this.#files.values()) {
        this.#closeOwned(file.fd, file.dev, file.ino);
      }
      if (this.#directory !== undefined) {
        this.#closeOwned(this.#directory, BigInt(this.#root.dev), BigInt(this.#root.ino));
      }
      this.#closed = true;
    });
    try {await ready.promise; this.assertIntact();}
    catch (error) {release.resolve(); await this.#running; throw error;}
  }
  #closeOwned(fd: number, dev: bigint, ino: bigint): void {
    try {
      const held = fstatSync(fd, {bigint: true});
      if (held.dev !== dev || held.ino !== ino) {this.#failed = true; return;}
      closeSync(fd);
    } catch {this.#failed = true;}
  }
  public create(name: "lifecycle" | "consumption", header: object): void {
    this.assertIntact();
    if (this.#directory === undefined || this.#files.has(name)) {reject();}
    let fd: number | undefined;
    try {
      fd = openSync(this.#filePath(name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const s = fstatSync(fd, {bigint: true});
      this.#files.set(name, {fd, dev: s.dev, ino: s.ino, size: 0, sequence: 0, tail: "0".repeat(64)});
      this.append(name, "header", header);
      fsyncSync(this.#directory!);
      this.assertIntact();
    } catch (error) {
      this.#failed = true;
      if (fd !== undefined && !this.#files.has(name)) {try {closeSync(fd);} catch { /* retain residue */ }}
      throw error;
    }
  }
  public append(name: "lifecycle" | "consumption", kind: string, data: object): void {
    try {
      this.assertIntact();
      const file = this.#files.get(name);
      if (file === undefined) {reject();}
      const payload = Buffer.from(JSON.stringify({schema: `darwin-route-${name}/v1`,
        sequence: file!.sequence, previous: file!.tail, kind, data}));
      if (payload.length > MAX_FRAME || file!.size + payload.length + 36 > MAX_BYTES) {reject();}
      const frame = Buffer.alloc(payload.length + 36);
      frame.writeUInt32BE(payload.length); frame.set(createHash("sha256").update(payload).digest(), 4); frame.set(payload, 36);
      let offset = 0;
      while (offset < frame.length) {
        const written = writeSync(file!.fd, frame, offset, frame.length - offset, file!.size + offset);
        if (!Number.isSafeInteger(written) || written <= 0 || written > frame.length - offset) {reject();}
        offset += written;
      }
      // Actual complete write and held-file durability precede the synchronous
      // first-byte return. Lost acknowledgement permanently burns this owner.
      fsyncSync(file!.fd);
      file!.size += frame.length; file!.sequence++; file!.tail = darwinDigest(frame);
      this.assertIntact();
    } catch (error) {this.#failed = true; throw error;}
  }
  public async close(): Promise<boolean> {
    this.#release?.(); await this.#running;
    return this.#closed && !this.#failed;
  }
}

/** Bounded forensic read only. It cannot issue live session/dispatch authority. */
export const inspectDarwinRouteResidue = (path: string): readonly object[] => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size < 36 || s.size > MAX_BYTES) {reject();}
    const bytes = readFileSync(fd); const records: object[] = [];
    let offset = 0; let tail = "0".repeat(64);
    while (offset < bytes.length) {
      if (records.length >= 1024 || bytes.length - offset < 36) {reject();}
      const length = bytes.readUInt32BE(offset);
      if (length < 1 || length > MAX_FRAME || length + 36 > bytes.length - offset) {reject();}
      const frame = bytes.subarray(offset, offset + length + 36);
      const payload = frame.subarray(36);
      if (!createHash("sha256").update(payload).digest().equals(frame.subarray(4, 36))) {reject();}
      const record = JSON.parse(payload.toString("utf8")) as {sequence: number; previous: string; schema: string};
      if (record.sequence !== records.length || record.previous !== tail ||
          !["darwin-route-lifecycle/v1", "darwin-route-consumption/v1"].includes(record.schema)) {reject();}
      records.push(Object.freeze(record)); tail = darwinDigest(frame); offset += frame.length;
    }
    if (fstatSync(fd).size !== bytes.length) {reject();}
    return Object.freeze(records);
  } finally {closeSync(fd);}
};
