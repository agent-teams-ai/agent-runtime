export type {
  LinuxStableDirectoryMutationCapability,
  PathCustodyBoundary,
  PathLineage,
  StableDirectoryMutationCapability,
  StableDirectoryMutationCapabilityDisposition,
  StableDirectoryPublicationOutcome,
  StablePathComponentIdentity,
  UnsupportedStableDirectoryMutationCapability,
} from "./contracts/stable-filesystem-custody.js";
export {
  PathCustodyError,
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
  type OpenedStablePath,
} from "./adapters/outbound/filesystem/stable-path-custody.js";
export {
  assertSameStableDirectoryMountIdentity,
  stableDirectoryMutationCapability,
  readStableDirectoryMountIdentity,
  resolveStableDirectoryMutationCapability,
} from "./adapters/outbound/filesystem/stable-directory-capability.js";
export {
  publishStableDirectoryNoReplace,
  StableDirectoryPublicationAmbiguousResidueError,
  StableDirectoryPublicationUnsupportedError,
} from "./adapters/outbound/filesystem/stable-directory-publication.js";
export { withStableDirectoryProcessLock } from "./adapters/outbound/filesystem/stable-directory-process-lock.js";
export {
  initializeDarwinHostAcquisitionGuard, hasDarwinHostDescriptors, isNativeHostDescriptor, openNativeHostRoot, openNativeHostEntry,
  duplicateNativeHostDescriptor, nativeHostPath, nativeHostMount, nativeHostMkdir,
  nativeHostUnlink, nativeHostNames, quarantineNativeHostEntry,
  type StableFilesystemHandle, type StableFilesystemStats,
} from "./adapters/outbound/filesystem/host-descriptor.js";
