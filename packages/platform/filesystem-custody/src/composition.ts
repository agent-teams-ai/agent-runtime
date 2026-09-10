export {
  PathCustodyError,
  capturePathLineage,
  openStablePath,
  pathLineagesEqual,
  type OpenedStablePath,
  type PathCustodyBoundary,
  type PathLineage,
} from "./stable-path-custody.js";
export {
  assertSameStableDirectoryMountIdentity,
  stableDirectoryMutationCapability,
  readStableDirectoryMountIdentity,
  resolveStableDirectoryMutationCapability,
  type StableDirectoryMutationCapability,
  type StableDirectoryMutationCapabilityDisposition,
  type UnsupportedStableDirectoryMutationCapability,
} from "./stable-directory-capability.js";
export {
  publishStableDirectoryNoReplace,
  StableDirectoryPublicationAmbiguousResidueError,
  StableDirectoryPublicationUnsupportedError,
  type StableDirectoryPublicationOutcome,
} from "./stable-directory-publication.js";
export { withStableDirectoryProcessLock } from "./stable-directory-process-lock.js";
export {
  initializeDarwinHostAcquisitionGuard, hasDarwinHostDescriptors, isNativeHostDescriptor, openNativeHostRoot, openNativeHostEntry,
  duplicateNativeHostDescriptor, nativeHostPath, nativeHostMount, nativeHostMkdir,
  nativeHostUnlink, nativeHostNames, quarantineNativeHostEntry,
  type StableFilesystemHandle, type StableFilesystemStats,
} from "./host-descriptor.js";
