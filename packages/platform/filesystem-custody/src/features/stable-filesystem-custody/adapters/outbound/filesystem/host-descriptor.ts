import { StableDirectoryPublicationUnsupportedError, StableDirectoryPublicationAmbiguousResidueError } from "./stable-directory-publication.js";
import type { BigIntStats } from "node:fs";
import { stableFilesystemNativeArtifactPath } from "../native/stable-filesystem-native-artifact.js";

export type StableFilesystemStats = Pick<BigIntStats,
  "dev" | "ino" | "mode" | "uid" | "nlink" | "size" | "ctimeNs" | "mtimeNs" |
  "isFile" | "isDirectory" | "isSymbolicLink">;

/** The descriptor subset needed by Host scanner and artifact/receipt owners. */
export interface StableFilesystemHandle {
  readonly fd: number;
  close(): Promise<void>;
  stat(options: { bigint: true }): Promise<StableFilesystemStats>;
  read(buffer: Buffer, offset: number, length: number, position: number | null):
    Promise<{ bytesRead: number; buffer: Buffer }>;
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
}
interface HostBinding {
  initializeDarwinHostAcquisitionGuard(): void;
  isDarwinHostAcquisitionGuardInstalled(): boolean;
  hostQuarantine(source: object, name: string, destination: object, target: string): number;
  hostRoot(): object;
  hostOpen(parent: object, name: string, kind: number): object;
  hostClose(handle: object): void;
  hostFd(handle: object): number;
  hostDuplicate(handle: object): object;
  hostStat(handle: object): Omit<StableFilesystemStats, "isFile" | "isDirectory" | "isSymbolicLink">;
  hostNames(handle: object, maximum: number): Buffer[];
  hostRead(handle: object, buffer: Buffer, position: number): number;
  hostWrite(handle: object, buffer: Buffer): void;
  hostSync(handle: object): void;
  hostChmod(handle: object, mode: number): void;
  hostMkdir(handle: object, name: string): void;
  hostUnlink(handle: object, name: string): void;
  hostPath(handle: object): string;
  hostMount(handle: object): string;
}
let binding: HostBinding | undefined;
const load = (): HostBinding => {
  if (binding !== undefined) {return binding;}
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, stableFilesystemNativeArtifactPath());
  const candidate = module.exports as Partial<HostBinding>;
  const keys: readonly (keyof HostBinding)[] = ["initializeDarwinHostAcquisitionGuard", "isDarwinHostAcquisitionGuardInstalled", "hostRoot", "hostOpen", "hostClose", "hostFd",
    "hostDuplicate", "hostStat", "hostNames", "hostRead", "hostWrite", "hostSync",
    "hostChmod", "hostMkdir", "hostUnlink", "hostPath", "hostMount", "hostQuarantine"];
  if (keys.some(key => typeof candidate[key] !== "function")) {
    throw new Error("the actual Darwin Host descriptor binding is unavailable");
  }
  binding = candidate as HostBinding;
  return binding;
};
export const hasDarwinHostDescriptors = (): boolean => {
  if (process.platform !== "darwin") {return false;}
  try {return load().isDarwinHostAcquisitionGuardInstalled() === true;} catch {return false;}
};
/** Only the fresh owned full Host child bootstrap may call this, before acquisition.
 * Failure requires child termination; this never runs during module loading. */
export const initializeDarwinHostAcquisitionGuard = (): void => {
  if (process.platform !== "darwin") {throw new Error("Darwin Host acquisition guard is unavailable");}
  load().initializeDarwinHostAcquisitionGuard();
  if (!load().isDarwinHostAcquisitionGuardInstalled()) {
    throw new Error("Darwin Host acquisition guard installation was not confirmed");
  }
};
const issued = new WeakMap<StableFilesystemHandle, object>();
const token = (handle: StableFilesystemHandle): object => {
  const value = issued.get(handle);
  if (value === undefined) {throw new TypeError("Host descriptor was not issued by this module");}
  load().hostFd(value);
  return value;
};
export const isNativeHostDescriptor = (handle: StableFilesystemHandle): boolean => issued.has(handle);
const wrap = (value: object): StableFilesystemHandle => {
  let position = 0;
  const handle: StableFilesystemHandle = Object.freeze({
    get fd(): number {return load().hostFd(value);},
    async close(): Promise<void> {load().hostClose(value);},
    async stat(_options: { bigint: true }): Promise<StableFilesystemStats> {
      const observed = load().hostStat(value);
      const kind = observed.mode & 0o170000n;
      return Object.freeze({ ...observed,
        isFile: () => kind === 0o100000n,
        isDirectory: () => kind === 0o040000n,
        isSymbolicLink: () => kind === 0o120000n,
      });
    },
    async read(buffer: Buffer, offset: number, length: number, at: number | null) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
          offset < 0 || length < 0 || offset + length > buffer.length) {
        throw new RangeError("Host read buffer bounds are invalid");
      }
      const bytesRead = load().hostRead(value, buffer.subarray(offset, offset + length), at ?? position);
      if (at === null) {position += bytesRead;}
      return { bytesRead, buffer };
    },
    async writeFile(bytes: Uint8Array): Promise<void> {
      if (bytes.byteLength > 32 * 1024 * 1024) {throw new RangeError("Host write exceeds byte ceiling");}
      load().hostFd(value);
      for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
        load().hostWrite(value, Buffer.from(bytes.buffer, bytes.byteOffset + offset,
          Math.min(65536, bytes.byteLength - offset)));
      }
    },
    async sync(): Promise<void> {load().hostSync(value);},
    async chmod(mode: number): Promise<void> {load().hostChmod(value, mode);},
  });
  issued.set(handle, value);
  return handle;
};
export const openNativeHostRoot = (): StableFilesystemHandle => {
  if (!hasDarwinHostDescriptors()) {throw new Error("actual Darwin Host descriptor support is unavailable");}
  return wrap(load().hostRoot());
};
export const openNativeHostEntry = (
  parent: StableFilesystemHandle, name: string, kind: "inspect" | "directory" | "create",
): StableFilesystemHandle => wrap(load().hostOpen(token(parent), name,
  kind === "create" ? 2 : kind === "directory" ? 1 : 0));
export const duplicateNativeHostDescriptor = (handle: StableFilesystemHandle): StableFilesystemHandle =>
  wrap(load().hostDuplicate(token(handle)));
export const nativeHostPath = (handle: StableFilesystemHandle): string => load().hostPath(token(handle));
export const nativeHostMount = (handle: StableFilesystemHandle): string => load().hostMount(token(handle));
export const nativeHostMkdir = (handle: StableFilesystemHandle, name: string): void =>
  load().hostMkdir(token(handle), name);
export const nativeHostUnlink = (handle: StableFilesystemHandle, name: string): void =>
  load().hostUnlink(token(handle), name);
export const nativeHostNames = (handle: StableFilesystemHandle, maximum: number): readonly string[] => {
  const names = load().hostNames(token(handle), maximum);
  return decodeHostNameBytes(names);
};

/** Internal byte decoder shared by Host enumeration; not a package export. */
export const decodeHostNameBytes = (names: readonly Uint8Array[]): readonly string[] => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return Object.freeze(names.map(name => decoder.decode(name)));
};

/** Quarantine one entry by its own no-follow metadata identity, with native
 * same-mount proof and recoverable no-replace capture. Caller syncs directories.
 * Only genuine Host descriptors are accepted; this does not grant read access. */
export const quarantineNativeHostEntry = (
  source: StableFilesystemHandle, name: string,
  destination: StableFilesystemHandle, target: string,
): "created" | "existing" => {
  const status = load().hostQuarantine(token(source), name, token(destination), target);
  if (status === 0) {return "created";}
  if (status === 73) {return "existing";}
  if (status === 74) {throw new StableDirectoryPublicationUnsupportedError("Host quarantine no-replace is unsupported");}
  if (status === 76) {throw new Error("Host quarantine source identity changed");}
  if (status === 77) {throw new StableDirectoryPublicationAmbiguousResidueError("Host quarantine has ambiguous identity-owned residue");}
  throw new Error("Host quarantine failed closed");
};
