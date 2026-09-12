import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGES = Object.freeze({
  "@agent-teams/agent-execution": true,
  "@agent-teams/provider-access": true,
  "@agent-teams/runtime-security": true,
});

/** Load a workspace package file from the development boundary without a package export. */
export const workspacePackageSourceHref = (packageName, relativeFromPackageRoot) => {
  if (!PACKAGES[packageName]) {
    throw new TypeError(`unsupported workspace package: ${packageName}`);
  }
  if (typeof relativeFromPackageRoot !== "string" || relativeFromPackageRoot.includes("\\")
      || relativeFromPackageRoot.startsWith("/") || relativeFromPackageRoot.split("/").includes("..")) {
    throw new TypeError(`invalid workspace package source path: ${relativeFromPackageRoot}`);
  }
  const compositionHref = import.meta.resolve(`${packageName}/composition`);
  return pathToFileURL(join(dirname(fileURLToPath(compositionHref)), "..", relativeFromPackageRoot)).href;
};
