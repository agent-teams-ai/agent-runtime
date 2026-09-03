import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

export class StableDirectoryPublicationUnsupportedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StableDirectoryPublicationUnsupportedError";
  }
}

export class StableDirectoryPublicationAmbiguousResidueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StableDirectoryPublicationAmbiguousResidueError";
  }
}

export type StableDirectoryPublicationOutcome = "created" | "existing";

interface NativePublicationBinding {
  publishNoReplace(
    sourceDirectory: number,
    sourceName: string,
    destinationDirectory: number,
    destinationName: string,
    expectedDevice: bigint,
    expectedInode: bigint,
    incompleteName: string,
  ): number;
}

let nativeBinding: NativePublicationBinding | undefined;

const assertEntryName = (name: string): void => {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new TypeError("stable directory publication entry name is invalid");
  }
};

const loadNativeBinding = (): NativePublicationBinding => {
  if (nativeBinding !== undefined) {return nativeBinding;}
  const loaded = { exports: {} } as NodeModule;
  try {
    process.dlopen(loaded, join(import.meta.dirname, "rename-no-replace.node"));
  } catch {
    throw new StableDirectoryPublicationUnsupportedError(
      "the qualified stable directory publication binding is unavailable",
    );
  }
  const candidate = loaded.exports as Partial<NativePublicationBinding>;
  if (typeof candidate.publishNoReplace !== "function") {
    throw new StableDirectoryPublicationUnsupportedError(
      "the qualified stable directory publication binding is invalid",
    );
  }
  nativeBinding = candidate as NativePublicationBinding;
  return nativeBinding;
};

export const publishStableDirectoryNoReplace = async (input: {
  readonly destinationDirectory: Pick<FileHandle, "fd">;
  readonly destinationName: string;
  readonly expectedSourceIdentity: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
  readonly sourceDirectory: Pick<FileHandle, "fd">;
  readonly sourceName: string;
}): Promise<StableDirectoryPublicationOutcome> => {
  assertEntryName(input.sourceName);
  assertEntryName(input.destinationName);
  if (process.platform !== "linux") {
    throw new StableDirectoryPublicationUnsupportedError(
      "no-replace stable directory publication is qualified only on Linux",
    );
  }
  const incompleteName = `.ar-publish-v1-${input.expectedSourceIdentity.dev.toString(16)}-${input.expectedSourceIdentity.ino.toString(16)}-${input.destinationName}.incomplete`;
  if (Buffer.byteLength(incompleteName) > 255) {
    throw new StableDirectoryPublicationUnsupportedError(
      "the destination name is too long for recoverable stable publication",
    );
  }
  const status = loadNativeBinding().publishNoReplace(
    input.sourceDirectory.fd,
    input.sourceName,
    input.destinationDirectory.fd,
    input.destinationName,
    input.expectedSourceIdentity.dev,
    input.expectedSourceIdentity.ino,
    incompleteName,
  );
  if (status === 0) {return "created";}
  if (status === 73) {return "existing";}
  if (status === 74) {
    throw new StableDirectoryPublicationUnsupportedError(
      "the current Linux filesystem cannot prove no-replace directory publication",
    );
  }
  if (status === 76) {throw new Error("stable directory publication source identity changed");}
  if (status === 77) {
    throw new StableDirectoryPublicationAmbiguousResidueError(
      "stable directory publication has ambiguous identity-owned residue",
    );
  }
  throw new Error("stable directory publication failed closed");
};
