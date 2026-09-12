export {
  PathCustodyError,
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
  type OpenedStablePath,
  type PathCustodyBoundary,
  type PathLineage,
  type StablePathComponentIdentity,
} from "./features/stable-filesystem-custody/internal.js";
export {
  assertSameStableDirectoryMountIdentity,
  stableDirectoryMutationCapability,
  readStableDirectoryMountIdentity,
  resolveStableDirectoryMutationCapability,
  type LinuxStableDirectoryMutationCapability,
  type StableDirectoryMutationCapability,
  type StableDirectoryMutationCapabilityDisposition,
  type UnsupportedStableDirectoryMutationCapability,
} from "./features/stable-filesystem-custody/internal.js";
export {
  publishStableDirectoryNoReplace,
  StableDirectoryPublicationAmbiguousResidueError,
  StableDirectoryPublicationUnsupportedError,
  type StableDirectoryPublicationOutcome,
} from "./features/stable-filesystem-custody/internal.js";
export { withStableDirectoryProcessLock } from "./features/stable-filesystem-custody/internal.js";
export {
  initializeDarwinHostAcquisitionGuard, hasDarwinHostDescriptors, isNativeHostDescriptor, openNativeHostRoot, openNativeHostEntry,
  duplicateNativeHostDescriptor, nativeHostPath, nativeHostMount, nativeHostMkdir,
  nativeHostUnlink, nativeHostNames, quarantineNativeHostEntry,
  type StableFilesystemHandle, type StableFilesystemStats,
} from "./features/stable-filesystem-custody/internal.js";
