import { join } from "node:path";

/** The qualified native artifact is emitted to the package `dist` root by
 * `scripts/build-native-helper.mjs`, while its loaders live under the feature
 * adapters. Only this module knows the distance between the two, so a later
 * layout change has one place to correct instead of three. */
export const stableFilesystemNativeArtifactPath = (): string =>
  join(import.meta.dirname, "../../../../..", "rename-no-replace.node");
