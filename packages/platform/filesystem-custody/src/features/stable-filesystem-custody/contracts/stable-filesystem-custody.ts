/** Portable identity of one resolved path component. Only plain scalars, so the
 * shape survives outside Node without importing a filesystem module. */
export interface StablePathComponentIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly path: string;
  readonly size: bigint;
}

/** Ordered component identities of one captured path, root first. */
export interface PathLineage {
  readonly components: readonly StablePathComponentIdentity[];
}

/** The two path spellings a custody caller must supply together. */
export interface PathCustodyBoundary {
  readonly absolutePath: string;
  readonly canonicalPath: string;
}

/** Whether publication created the destination or found it already published. */
export type StableDirectoryPublicationOutcome = "created" | "existing";

export interface LinuxStableDirectoryMutationCapability {
  readonly descriptorRoot: "/proc/self/fd";
  readonly kind: "supported";
  readonly platform: "linux";
  readonly version: 1;
}

export type StableDirectoryMutationCapability = LinuxStableDirectoryMutationCapability | {
  readonly kind: "supported"; readonly platform: "darwin"; readonly version: 1;
};

/** The host identities custody can observe. Spelled out rather than taken from
 * the ambient Node namespace, so a consumer of the published declarations needs
 * no Node type definitions. The adapters assert this stays equal to the runtime's
 * own union. */
export type StableCustodyPlatform =
  | "aix"
  | "android"
  | "cygwin"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "netbsd"
  | "openbsd"
  | "sunos"
  | "win32";

export interface UnsupportedStableDirectoryMutationCapability {
  readonly kind: "unsupported";
  readonly platform: StableCustodyPlatform;
  readonly reason: string;
  readonly version: 1;
}

export type StableDirectoryMutationCapabilityDisposition =
  | StableDirectoryMutationCapability
  | UnsupportedStableDirectoryMutationCapability;
