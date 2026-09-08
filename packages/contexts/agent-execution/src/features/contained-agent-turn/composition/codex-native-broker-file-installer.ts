import {NodeCodexNativeBrokerFileInstaller}
  from "../adapters/outbound/codex-native-files/codex-native-broker-file-installer.js";
import {retainedHostPrivateRootBinding, type HostPrivateRootOwner} from "./host-private-root-owner.js";
import type {DockerCodexNativeBrokerFinalizerInput} from "./docker-codex-native-broker-finalizer.js";
import type {CodexAppServerPermissionBoundary}
  from "../adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";

export interface CodexNativeBrokerFileInstallerOptions {
  readonly rootOwner: HostPrivateRootOwner;
  readonly boundary: CodexAppServerPermissionBoundary;
  /** Explicit upstream catalog bytes; copied at construction, pinned at install. */
  readonly catalogSource: Uint8Array;
  readonly ownerUid: number;
  readonly ownerGid: number;
}
export interface CodexNativeBrokerFileInstallerSnapshot {
  readonly installing: boolean;
  readonly installed: boolean;
  readonly debt: boolean;
  readonly retainedHandles: number;
}
export interface CodexNativeBrokerFileInstaller {
  readonly nativeFiles: DockerCodexNativeBrokerFinalizerInput["nativeFiles"];
  snapshot(): CodexNativeBrokerFileInstallerSnapshot;
  /** Join this BEFORE the existing root owner's quarantineAndDelete, alongside
   * other private consumers. This releases installer handles, never file debt.
   * File debt clears only when that same root owner proves deletion. */
  quiesce(): Promise<void>;
}

/** Inert private Host construction. The retained root must be captured before
 * install; no files, launch proof, credentials or alternate lifecycle are issued. */
export const createCodexNativeBrokerFileInstaller = (
  input: CodexNativeBrokerFileInstallerOptions,
): CodexNativeBrokerFileInstaller => {
  const {rootOwner, boundary, ownerUid, ownerGid} = input;
  retainedHostPrivateRootBinding(rootOwner);
  const owner = new NodeCodexNativeBrokerFileInstaller({boundary, ownerUid, ownerGid,
    catalogSource: Buffer.from(input.catalogSource),
    binding: () => {
      const binding = retainedHostPrivateRootBinding(rootOwner);
      if (binding === undefined) {throw new TypeError("Codex file installer requires captured Host root");}
      return binding;
    },
    revalidate: rootOwner.revalidate.bind(rootOwner),
    deleted: () => {
      const readback = rootOwner.snapshot();
      return readback.evidence.status === "deleted" && !readback.debt && readback.retainedHandles === 0;
    },
  });
  return Object.freeze({nativeFiles: Object.freeze({install: owner.install.bind(owner)}),
    snapshot: owner.snapshot.bind(owner), quiesce: owner.quiesce.bind(owner)});
};
