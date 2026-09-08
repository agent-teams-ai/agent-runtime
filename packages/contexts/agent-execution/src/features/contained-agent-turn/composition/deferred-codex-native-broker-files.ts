import {createCodexNativeBrokerFileInstaller, type CodexNativeBrokerFileInstaller,
  type CodexNativeBrokerFileInstallerOptions, type CodexNativeBrokerFileInstallerSnapshot}
  from "./codex-native-broker-file-installer.js";
import {retainedHostPrivateRootBinding, type HostPrivateRootOwner} from "./host-private-root-owner.js";
import type {CodexNativeBrokerRecipe} from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

export type DeferredCodexNativeBrokerFilesOptions = Omit<CodexNativeBrokerFileInstallerOptions, "rootOwner">;
export interface DeferredCodexNativeBrokerFiles {
  install(recipe: CodexNativeBrokerRecipe): Promise<void>;
  bindRoot(rootOwner: HostPrivateRootOwner): void;
  cutoff(): void;
  quiesce(): Promise<void>;
  snapshot(): CodexNativeBrokerFileInstallerSnapshot & Readonly<{
    binding: "unbound" | "binding" | "bound" | "failed";
    closed: boolean;
  }>;
}

/** Reservation-scoped inert adapter. Only the explicitly supplied captured root
 * owns residue and deletion; quiescence joins handles without waiting on debt. */
export const createDeferredCodexNativeBrokerFiles = (
  input: DeferredCodexNativeBrokerFilesOptions,
): DeferredCodexNativeBrokerFiles => {
  const options = {boundary: input.boundary, ownerUid: input.ownerUid, ownerGid: input.ownerGid,
    catalogSource: Buffer.from(input.catalogSource)};
  let binding: "unbound" | "binding" | "bound" | "failed" = "unbound";
  let closed = false;
  let installer: CodexNativeBrokerFileInstaller | undefined;
  let joining: Promise<void> | undefined;
  const cutoff = () => {
    closed = true;
    if (installer !== undefined && joining === undefined) {
      try {joining = installer.quiesce();} catch (error) {joining = Promise.reject(error);}
      // Retain failure for every observer without an unhandled rejection window.
      void joining.catch(() => {});
    }
  };
  return Object.freeze({
    bindRoot(rootOwner: HostPrivateRootOwner) {
      if (binding !== "unbound" || closed) {throw new TypeError("Native file binding unavailable");}
      binding = "binding";
      try {
        if (retainedHostPrivateRootBinding(rootOwner) === undefined) {throw new TypeError("Native files require captured root");}
        installer = createCodexNativeBrokerFileInstaller({...options, rootOwner});
        if (closed) {cutoff(); throw new TypeError("Native file binding closed");}
        binding = "bound";
      } catch (error) {binding = "failed"; throw error;}
    },
    async install(recipe: CodexNativeBrokerRecipe) {
      if (binding !== "bound" || closed || installer === undefined) {throw new TypeError("Native file installation unavailable");}
      await installer.nativeFiles.install(recipe);
    },
    cutoff,
    async quiesce() {cutoff(); await joining;},
    snapshot() {
      return Object.freeze({...installer?.snapshot() ?? {installing: false, installed: false, debt: false, retainedHandles: 0},
        binding, closed});
    },
  });
};
