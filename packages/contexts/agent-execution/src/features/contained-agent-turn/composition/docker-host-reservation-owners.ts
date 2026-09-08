import type {DeferredCodexNativeBrokerFiles} from "./deferred-codex-native-broker-files.js";
import {createHash} from "node:crypto";
import type {createHostPrivateRootOwnerFactory, HostPrivateRootOwner} from "./host-private-root-owner.js";
import {createDockerImageInitOwner, NodeUnixSocketDockerEngine, awaitNetworkCleanupWork, type DockerImageInitLock, type PreparedDockerProviderIo}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {DockerLinuxClaimedJoin, DockerLinuxPostClaimDependencies, DockerLinuxPostClaimOwner}
  from "./docker-linux-post-claim-preparation.js";
import type {DockerKernelHostCustody} from "./docker-kernel-host-custody.js";

/** One retained root factory per Host incarnation; each reservation attaches its
 * resource-free preparation owner before capture or any Docker allocation. */
export const createDockerHostReservationOwners = (input: Readonly<{
  roots: ReturnType<typeof createHostPrivateRootOwnerFactory>;
  raw: DockerKernelHostCustody;
  custodyRef: string;
  dependencies: DockerLinuxPostClaimDependencies;
  lock: DockerImageInitLock;
  nativeFiles: DeferredCodexNativeBrokerFiles;
  signal: AbortSignal;
  /** Fence the retained provider creator before quiescence; its root validation
   * is synchronous and must not resume after a cancellation waiter returns. */
  cutoffProvider(): void;
}>) => {
  let root: HostPrivateRootOwner | undefined;
  const cutoffProvider = input.cutoffProvider;
  let attached = false;
  let cut = false;
  const active = () => {
    if (cut || input.signal.aborted) {throw new TypeError("Docker Host reservation closed");}
  };
  const hooks: Required<Pick<DockerLinuxClaimedJoin<PreparedDockerProviderIo>, "captureHost" | "beforeLaunch">> = {
    async captureHost() {
      if (root === undefined) {throw new TypeError("Docker Host root must be attached before preparation");}
      active();
      const binding = await root.capture();
      active();
      const reservation = input.raw.reservation(input.custodyRef).input;
      if (binding.canonicalBindSourcePath !== reservation.launchPlan.privateRootPath ||
        binding.canonicalWorkspacePath !== reservation.workspaceRef ||
        input.dependencies.create.privateRootSource !== binding.canonicalBindSourcePath ||
        input.dependencies.create.workspaceSource !== binding.canonicalWorkspacePath) {
        throw new TypeError("Docker Host root conflicts with selected plan mounts");
      }
      active();
      input.nativeFiles.bindRoot(root);
      active();
      return Object.freeze({create: Object.freeze({...input.dependencies.create,
        privateRootSource: binding.canonicalBindSourcePath, workspaceSource: binding.canonicalWorkspacePath}),
        hostLifecycleGenerationSha256: binding.hostLifecycleGenerationSha256});
    },
    async beforeLaunch({identity, policy}) {
      if (root === undefined) {throw new TypeError("Docker Host root unavailable");}
      active();
      const binding = await root.revalidate();
      active();
      if (identity.hostBootGenerationSha256 !== createHash("sha256").update(binding.physicalHostBootId).digest("hex")) {
        throw new TypeError("Docker Engine and private root belong to different Host boots");
      }
      const host = Object.freeze({hostIdentitySha256: identity.hostIdentitySha256,
        hostBootGenerationSha256: identity.hostBootGenerationSha256,
        hostLifecycleGenerationSha256: binding.hostLifecycleGenerationSha256});
      const engine = new NodeUnixSocketDockerEngine({policy,
        ...(input.dependencies.engineClient === undefined ? {} : {client: input.dependencies.engineClient})});
      return Object.freeze({owner: createDockerImageInitOwner({engine, lock: input.lock, host}), host});
    },
  };
  return Object.freeze({hooks, attach(preparation: DockerLinuxPostClaimOwner<PreparedDockerProviderIo>) {
    if (attached) {throw new TypeError("Docker Host root attachment is one-use");}
    attached = true;
    active();
    const reservation = input.raw.reservation(input.custodyRef).input;
    let cutoffFailed = false;
    let filesFlight: Promise<void> | undefined;
    let preparationFlight: ReturnType<typeof preparation.cleanup> | undefined;
    const cutoff = () => {
      cut = true;
      for (const close of [cutoffProvider, () => input.nativeFiles.cutoff(), () => preparation.cutoff()]) {
        try {close();} catch {cutoffFailed = true;}
      }
    };
    const quiescence = Object.freeze({cutoff, async cleanup(call: Readonly<{deadlineEpochMs: number}>) {
      cutoff();
      filesFlight ??= Promise.resolve().then(() => input.nativeFiles.quiesce());
      preparationFlight ??= Promise.resolve().then(() => preparation.cleanup(call)).then(result => {
        // Preparation's own observation may expire. Retain its underlying owner,
        // but allow a later observation to join late settlement with a new deadline.
        if (result.kind !== "released") {preparationFlight = undefined;}
        return result;
      });
      const work = Promise.allSettled([filesFlight, preparationFlight]);
      try {
        if (!Number.isSafeInteger(call.deadlineEpochMs)) {throw new TypeError("Invalid cleanup deadline");}
        await awaitNetworkCleanupWork(work, {signal: new AbortController().signal,
          deadlineEpochMs: call.deadlineEpochMs});
        const results = await work;
        return Object.freeze({kind: !cutoffFailed && results[0].status === "fulfilled" &&
          results[1].status === "fulfilled" && results[1].value.kind === "released" ? "released" as const : "quarantined" as const});
      } catch {return Object.freeze({kind: "quarantined" as const});}
    }});
    root = input.roots.create({rootPath: reservation.launchPlan.privateRootPath, workspacePath: reservation.workspaceRef,
      operationId: reservation.operationId, attemptId: reservation.attemptId, custodyRef: input.custodyRef}, quiescence);
    input.raw.installCleanup(input.custodyRef, quiescence);
    input.raw.installPrivateRoot(input.custodyRef, root);
  }});
};
