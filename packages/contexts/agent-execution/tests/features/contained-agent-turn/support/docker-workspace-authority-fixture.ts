import {open} from "node:fs/promises";
import {basename, dirname} from "node:path";
import type {TestContext} from "node:test";
import {createWorkspaceCapabilityRetention, type ResolvedWorkspaceLaunchAuthority}
  from "../../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-capability.js";
import type {DockerKernelHostCustody} from "../../../../dist/features/contained-agent-turn/composition/docker-kernel-host-custody.js";
import type {HostCustodyReservationInput} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

/** Positive reservation tests use the production callback capability and real
 * disposable directory descriptors; no private proof issuer is substituted. */
export const withWorkspaceAuthority = async <T>(workspaceRef: string, operationId: string,
  consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<T>): Promise<T> => {
  const parent = await open(dirname(workspaceRef), "r");
  const owner = createWorkspaceCapabilityRetention();
  const scope = {tenantId: "tenant:workspace-fixture", projectId: "project:workspace-fixture"};
  try {
    const authority = await owner.retain({canonicalPath: workspaceRef, workspaceRef, operationId,
      name: basename(workspaceRef), parent, scope});
    return await owner.consume({authority, workspaceRef, operationId, scope}, consume);
  } finally {await owner.dispose(); await parent.close();}
};

export const reserveWorkspace = async (t: TestContext, raw: DockerKernelHostCustody,
  input: Omit<HostCustodyReservationInput, "workspaceAuthority">) => {
  const opened = await withWorkspaceAuthority(input.workspaceRef, input.operationId,
    workspaceAuthority => raw.reserve({...input, workspaceAuthority}));
  // Fixture-local descriptor disposal is not a production containment receipt.
  const workspace = raw.reservation(opened.custodyRef).workspace;
  t.after(() => workspace.close());
  return opened;
};
