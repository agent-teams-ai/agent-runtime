import {createHash} from "node:crypto";
import type {createHostPrivateRootOwnerFactory, HostPrivateRootOwner} from "./host-private-root-owner.js";
import {createDockerImageInitOwner, type DockerImageInitLock, type PreparedDockerProviderIo}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {NodeUnixSocketDockerEngine} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
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
  /** Fence the retained provider creator before quiescence; its root validation
   * is synchronous and must not resume after a cancellation waiter returns. */
  cutoffProvider(): void;
}>) => {
  let root: HostPrivateRootOwner | undefined;
  const cutoffProvider = input.cutoffProvider;
  const hooks: Required<Pick<DockerLinuxClaimedJoin<PreparedDockerProviderIo>, "captureHost" | "beforeLaunch">> = {
    async captureHost() {
      if (root === undefined) {throw new TypeError("Docker Host root must be attached before preparation");}
      const binding = await root.capture();
      const reservation = input.raw.reservation(input.custodyRef).input;
      if (binding.canonicalBindSourcePath !== reservation.launchPlan.privateRootPath ||
        binding.canonicalWorkspacePath !== reservation.workspaceRef ||
        input.dependencies.create.privateRootSource !== binding.canonicalBindSourcePath ||
        input.dependencies.create.workspaceSource !== binding.canonicalWorkspacePath) {
        throw new TypeError("Docker Host root conflicts with selected plan mounts");
      }
      return Object.freeze({create: Object.freeze({...input.dependencies.create,
        privateRootSource: binding.canonicalBindSourcePath, workspaceSource: binding.canonicalWorkspacePath}),
        hostLifecycleGenerationSha256: binding.hostLifecycleGenerationSha256});
    },
    async beforeLaunch({identity, policy}) {
      if (root === undefined) {throw new TypeError("Docker Host root unavailable");}
      const binding = await root.revalidate();
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
    if (root !== undefined) {throw new TypeError("Docker Host root attachment is one-use");}
    const reservation = input.raw.reservation(input.custodyRef).input;
    const quiescence = Object.freeze({cutoff() {
      try {cutoffProvider();} finally {preparation.cutoff();}
    }, async cleanup(call: Readonly<{deadlineEpochMs: number}>) {
      try {cutoffProvider();} catch {preparation.cutoff(); return Object.freeze({kind: "quarantined" as const});}
      return preparation.cleanup(call);
    }});
    root = input.roots.create({rootPath: reservation.launchPlan.privateRootPath, workspacePath: reservation.workspaceRef,
      operationId: reservation.operationId, attemptId: reservation.attemptId, custodyRef: input.custodyRef}, quiescence);
    input.raw.installCleanup(input.custodyRef, quiescence);
    input.raw.installPrivateRoot(input.custodyRef, root);
  }});
};
